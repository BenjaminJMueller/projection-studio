# Simuliert die relevanten Teile von TouchDesigner, um apply_calibration.py zu prüfen.
# Die Fenster-Konvention (Vorzeichen/Skalierung von winx/winy) ist absichtlich "unbekannt",
# das Skript muss sie über die Selbstprüfung selbst herausfinden.
import json, math, sys

SIGN_X, SIGN_Y, SCALE = float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])

class ParMode:
    CONSTANT = 0
    EXPRESSION = 1

class Par:
    def __init__(self, v): self.val = v; self.mode = ParMode.EXPRESSION
    def eval(self): return self.val

class Pars:
    def __init__(self, d): self.__dict__.update({k: Par(v) for k, v in d.items()})

class Matrix:
    def __init__(self, rows): self.vals = [x for r in rows for x in r]

def rot(rx, ry, rz):
    a, b, c = map(math.radians, (rx, ry, rz))
    Rx = [[1,0,0],[0,math.cos(a),-math.sin(a)],[0,math.sin(a),math.cos(a)]]
    Ry = [[math.cos(b),0,math.sin(b)],[0,1,0],[-math.sin(b),0,math.cos(b)]]
    Rz = [[math.cos(c),-math.sin(c),0],[math.sin(c),math.cos(c),0],[0,0,1]]
    mm = lambda A,B: [[sum(A[i][k]*B[k][j] for k in range(3)) for j in range(3)] for i in range(3)]
    return mm(Rz, mm(Ry, Rx))

class Cam:
    path = '/project1/Kamera_P1'
    def __init__(self):
        self.par = Pars(dict(tx=0,ty=0,tz=0,rx=0,ry=0,rz=0,sx=1,sy=1,sz=1,px=0,py=0,pz=0,scale=1,xord='srt',rord='xyz',
            projection='perspective',viewanglemethod='horizontal',fov=45,near=0.1,far=100,winsize=1,winroll=0,winx=0,winy=0))
    def projection(self, w, h):
        p = self.par
        f = 1 / math.tan(math.radians(p.fov.val) / 2)
        n, fa = p.near.val, p.far.val
        rows = [[f,0,SCALE*SIGN_X*p.winx.val,0],[0,f*w/h,SCALE*SIGN_Y*p.winy.val,0],[0,0,-(fa+n)/(fa-n),-2*fa*n/(fa-n)],[0,0,-1,0]]
        return Matrix(rows)
    @property
    def worldTransform(self):
        p = self.par
        R = rot(p.rx.val, p.ry.val, p.rz.val)
        S = [p.sx.val, p.sy.val, p.sz.val]
        rows = [[R[i][j]*S[j] for j in range(3)] + [[p.tx.val,p.ty.val,p.tz.val][i]] for i in range(3)] + [[0,0,0,1]]
        # TD liefert column-major -> transponiert ablegen, das Skript muss das erkennen
        return Matrix([list(r) for r in zip(*rows)])

cam = Cam()
class Net:
    def op(self, name): return cam
g = {'ParMode': ParMode, 'op': lambda p: Net(), 'me': None, 'project': None, 'KALIB_NO_AUTORUN': True, 'print': lambda *a: sys.stderr.write(' '.join(map(str, a)) + '\n')}
exec(open('td/apply_calibration.py', encoding='utf-8').read(), g)
pj = json.load(open(sys.argv[1]))
g['apply_projector'](Net(), pj, None)
P = g['projection_rows'](cam, pj['touchdesigner']['resx'], pj['touchdesigner']['resy'])
T = g['mat_from_flat'](pj['touchdesigner']['projectionMatrix'])
perr = max(abs(P[i][j] - T[i][j]) for i in range(2) for j in range(3))
Wt = g['td_matrix_rows'](cam.worldTransform)
Wt = [list(r) for r in zip(*Wt)]
M = g['mat_from_flat'](pj['touchdesigner']['worldMatrix'])
terr = max(abs(Wt[i][j] - M[i][j]) for i in range(3) for j in range(4))
print(json.dumps({'perr': perr, 'terr': terr}))
