# -----------------------------------------------------------------------------
# Projektor-Kalibrator -> TouchDesigner
#
# Übernimmt die Kalibrierung (Kamera-Position, Rotation, FOV, Lens Shift) aus
# kalibrierung.json auf die Kamera-COMPs und (optional) die Blend-/Masken-PNGs.
#
# Verwendung:
#   1. Export-Ordner "kalibrierung" neben die .toe-Datei legen
#      (oder JSON_PATH unten setzen).
#   2. In TouchDesigner einen Text DAT im selben Netzwerk wie die Kameras anlegen,
#      diesen Code hineinkopieren (oder den Parameter "File" auf diese Datei setzen).
#   3. Rechtsklick auf den Text DAT -> "Run Script". Ergebnis steht im Textport.
#
# Das Skript prüft sich selbst: Nach dem Setzen wird die tatsächliche
# Projektionsmatrix der Kamera mit der berechneten verglichen und Lens Shift /
# FOV werden automatisch nachjustiert. Damit ist es unabhängig davon, wie die
# Kamera-Parameter intern skaliert sind.
# -----------------------------------------------------------------------------

import json
import math
import os

JSON_PATH = ''        # leer = <Projektordner>/kalibrierung/kalibrierung.json
NETWORK_PATH = ''     # leer = Netzwerk, in dem dieser DAT liegt
GEO_PATH = ''         # optional: Geometry COMP des Gewölbes, falls es eine eigene Transformation hat
SETUP_MASKS = False   # True = pro Projektor "Maske_Px" (Movie File In) + "Blend_Px" (Multiply) hinter "Projektion_Px" einfügen
PROJEKTION_NAMES = {  # Render TOP pro Projektor (für SETUP_MASKS)
    'P1': 'Projektion',
}


def log(*a):
    print('[Kalibrator]', *a)


def load_json():
    path = JSON_PATH or os.path.join(project.folder, 'kalibrierung', 'kalibrierung.json')
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f), path


def setpar(o, name, value):
    p = getattr(o.par, name, None)
    if p is None:
        return False
    try:
        if p.mode != ParMode.CONSTANT:
            p.mode = ParMode.CONSTANT  # Ausdrücke/Exports (z. B. von camSchnappr) lösen
    except Exception:
        pass
    try:
        p.val = value
        return True
    except Exception:
        return False


# --- Matrix-Helfer (row-major 4x4 als Liste von Listen) ----------------------

def mat_from_flat(v):
    return [list(v[0:4]), list(v[4:8]), list(v[8:12]), list(v[12:16])]


def mat_mul(A, B):
    return [[sum(A[i][k] * B[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def td_matrix_rows(m):
    """tdu.Matrix -> row-major Liste, unabhängig von der internen Ablage."""
    vals = None
    for attr in ('vals',):
        if hasattr(m, attr):
            vals = list(getattr(m, attr))
    if vals is None:
        try:
            vals = [m[i, j] for i in range(4) for j in range(4)]
        except Exception:
            vals = [x for row in m for x in row]
    rows = mat_from_flat(vals)
    return rows


def projection_rows(cam, w, h):
    rows = td_matrix_rows(cam.projection(w, h))
    # Perspektivmatrix: die -1 steht in Zeile 3, Spalte 2 (row-major). Sonst transponiert.
    if abs(rows[3][2] + 1) > 1e-4 and abs(rows[2][3] + 1) < 1e-4:
        rows = [list(r) for r in zip(*rows)]
    return rows


def decompose(M):
    """Welt-Matrix -> (t, euler xyz in Grad, scale) für Rotationsreihenfolge xyz (R = Rz*Ry*Rx)."""
    cols = [[M[0][j], M[1][j], M[2][j]] for j in range(3)]
    sc = [math.sqrt(sum(c * c for c in col)) for col in cols]
    det = (M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1])
           - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0])
           + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]))
    if det < 0:
        sc[0] = -sc[0]
    R = [[M[i][j] / sc[j] for j in range(3)] for i in range(3)]
    sy = -R[2][0]
    ry = math.asin(max(-1.0, min(1.0, sy)))
    if abs(sy) < 0.999999:
        rx = math.atan2(R[2][1], R[2][2])
        rz = math.atan2(R[1][0], R[0][0])
    else:
        rx = math.atan2(-R[1][2], R[1][1])
        rz = 0.0
    return [M[0][3], M[1][3], M[2][3]], [math.degrees(rx), math.degrees(ry), math.degrees(rz)], sc


def apply_projector(net, pj, geoM):
    td = pj['touchdesigner']
    name = pj.get('tdCamera') or ('Kamera_' + pj['id'])
    cam = net.op(name) or op(name)
    if cam is None:
        log(pj['id'], ': Kamera', name, 'nicht gefunden – übersprungen')
        return False

    M = mat_from_flat(td['worldMatrix'])
    if geoM is not None:
        M = mat_mul(geoM, M)
    t, r, s = decompose(M)

    setpar(cam, 'xord', 'srt')
    setpar(cam, 'rord', 'xyz')
    for n_, v in zip(('tx', 'ty', 'tz'), t):
        setpar(cam, n_, v)
    for n_, v in zip(('rx', 'ry', 'rz'), r):
        setpar(cam, n_, v)
    for n_, v in zip(('sx', 'sy', 'sz'), s):
        setpar(cam, n_, v)
    for n_ in ('px', 'py', 'pz'):
        setpar(cam, n_, 0)
    setpar(cam, 'scale', 1)

    W, H = td['resx'], td['resy']
    setpar(cam, 'projection', 'perspective')
    setpar(cam, 'viewanglemethod', 'horizontal')
    setpar(cam, 'fov', td['fov'])
    setpar(cam, 'near', td['near'])
    setpar(cam, 'far', td['far'])
    if not setpar(cam, 'winsize', 1):
        setpar(cam, 'winsizex', 1)
        setpar(cam, 'winsizey', 1)
    setpar(cam, 'winroll', 0)
    setpar(cam, 'winx', td['winx'])
    setpar(cam, 'winy', td['winy'])

    target = mat_from_flat(td['projectionMatrix'])
    try:
        # FOV nachjustieren (falls TD den Winkel anders interpretiert)
        for _ in range(3):
            P = projection_rows(cam, W, H)
            if abs(P[0][0]) < 1e-9:
                break
            ratio = P[0][0] / target[0][0]
            if abs(ratio - 1) < 1e-6:
                break
            half = math.atan(math.tan(math.radians(cam.par.fov.eval()) / 2) * ratio)
            setpar(cam, 'fov', math.degrees(2 * half))
        # Lens Shift: 2x2-Jacobi von (P02, P12) nach (winx, winy) messen und lösen
        def shifts(wx, wy):
            setpar(cam, 'winx', wx)
            setpar(cam, 'winy', wy)
            P = projection_rows(cam, W, H)
            return P[0][2], P[1][2]
        a0 = shifts(0, 0)
        ax = shifts(0.1, 0)
        ay = shifts(0, 0.1)
        j11, j21 = (ax[0] - a0[0]) / 0.1, (ax[1] - a0[1]) / 0.1
        j12, j22 = (ay[0] - a0[0]) / 0.1, (ay[1] - a0[1]) / 0.1
        det = j11 * j22 - j12 * j21
        if abs(det) > 1e-9:
            b1, b2 = target[0][2] - a0[0], target[1][2] - a0[1]
            wx = (b1 * j22 - j12 * b2) / det
            wy = (j11 * b2 - b1 * j21) / det
            shifts(wx, wy)
        else:
            shifts(td['winx'], td['winy'])
            log(pj['id'], ': Lens Shift konnte nicht gemessen werden, nutze berechnete Werte')
        P = projection_rows(cam, W, H)
        err = max(abs(P[i][j] - target[i][j]) for i in range(2) for j in range(3))
        status = 'OK' if err < 1e-3 else 'ABWEICHUNG %.4f' % err
    except Exception as e:
        status = 'ohne Selbstprüfung (%s)' % e

    # Transform prüfen
    try:
        Wt = td_matrix_rows(cam.worldTransform)
        if abs(Wt[3][0]) + abs(Wt[3][1]) + abs(Wt[3][2]) > 1e-6:
            Wt = [list(rr) for rr in zip(*Wt)]
        terr = max(abs(Wt[i][j] - M[i][j]) for i in range(3) for j in range(4))
        if terr > 1e-3:
            status += ' | Transform weicht ab (%.4f) – hat die Kamera einen Parent mit Transformation oder einen Pre-Transform?' % terr
    except Exception:
        pass

    log('%s -> %s: fov %.2f°, winx %.4f, winy %.4f, RMS %.2f px  [%s]' % (
        pj['id'], cam.path, cam.par.fov.eval(), cam.par.winx.eval(), cam.par.winy.eval(),
        pj['quality']['rmsPx'], status))
    return True


def setup_masks(net, data, base):
    for pj in data['projectors']:
        mask_file = (pj.get('maskFile') or '')
        if not mask_file:
            continue
        mask_path = os.path.join(base, mask_file)
        pid = pj['id']
        mname, bname = 'Maske_' + pid, 'Blend_' + pid
        m = net.op(mname)
        if m is None and SETUP_MASKS:
            render = net.op(PROJEKTION_NAMES.get(pid, 'Projektion_' + pid))
            if render is None:
                log(pid, ': Render TOP nicht gefunden, Maske nicht eingefügt')
                continue
            m = net.create(moviefileinTOP, mname)
            m.nodeX, m.nodeY = render.nodeX - 150, render.nodeY - 120
            b = net.create(multiplyTOP, bname)
            b.nodeX, b.nodeY = render.nodeX, render.nodeY - 120
            # bisherige Ausgänge von render auf b umhängen
            downstream = []
            for oc in render.outputConnectors:
                for c in oc.connections:
                    downstream.append(c)
            b.inputConnectors[0].connect(render)
            b.inputConnectors[1].connect(m)
            for c in downstream:
                c.connect(b)
            log(pid, ': Maske + Multiply eingefügt')
        if m is not None:
            setpar(m, 'file', mask_path)
            setpar(m, 'play', 0)


def run():
    data, path = load_json()
    base = os.path.dirname(path)
    net = op(NETWORK_PATH) if NETWORK_PATH else me.parent()
    geoM = None
    if GEO_PATH:
        g = op(GEO_PATH)
        if g is not None:
            geoM = td_matrix_rows(g.worldTransform)
            if abs(geoM[3][0]) + abs(geoM[3][1]) + abs(geoM[3][2]) > 1e-6:
                geoM = [list(rr) for rr in zip(*geoM)]
    n = 0
    for pj in data['projectors']:
        if pj.get('touchdesigner'):
            n += apply_projector(net, pj, geoM)
    setup_masks(net, data, base)
    log('%d Projektor(en) übernommen aus %s' % (n, path))


if not globals().get('KALIB_NO_AUTORUN'):
    run()
