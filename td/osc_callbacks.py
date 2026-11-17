# -----------------------------------------------------------------------------
# Projection Studio -> TouchDesigner LIVE (OSC)
#
# Einrichtung (einmalig):
#   1. Text DAT "apply_calibration" mit dem Inhalt von apply_calibration.py anlegen
#      (im selben Netzwerk wie die Kameras).
#   2. OSC In DAT anlegen, Network Port = 7000 (wie in der App eingestellt).
#   3. Im OSC In DAT als "Callbacks DAT" einen Text DAT mit DIESEM Code setzen.
#   4. In der App unter Ausgabe → TouchDesigner „Live senden“ einschalten.
# Jede Änderung der Kalibrierung landet dann sofort auf den Kameras.
# -----------------------------------------------------------------------------
import json

APPLY_DAT = 'apply_calibration'   # Name des Text DAT mit apply_calibration.py

_cache = {}


def _apply_module():
    dat = op(APPLY_DAT) or parent().op(APPLY_DAT)
    if dat is None:
        print('[Kalibrator] Text DAT', APPLY_DAT, 'nicht gefunden')
        return None
    if _cache.get('text') != dat.text:
        g = dict(globals())
        g['KALIB_NO_AUTORUN'] = True
        exec(dat.text, g)
        _cache['text'] = dat.text
        _cache['g'] = g
    return _cache['g']


def onReceiveOSC(dat, rowIndex, message, bytes, timeStamp, address, args, peer):
    if address != '/kalibrator/projector' or not args:
        return
    g = _apply_module()
    if g is None:
        return
    try:
        pj = json.loads(args[0])
    except Exception as e:
        print('[Kalibrator] ungültige Nachricht:', e)
        return
    net = op(g.get('NETWORK_PATH') or '') if g.get('NETWORK_PATH') else dat.parent()
    geoM = None
    if g.get('GEO_PATH'):
        go = op(g['GEO_PATH'])
        if go is not None:
            geoM = g['td_matrix_rows'](go.worldTransform)
    g['apply_projector'](net, pj, geoM)
    return
