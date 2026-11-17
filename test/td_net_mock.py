# Mini-Netzwerk für setup_masks/setup_warp: Render -> Out, danach muss Render -> Blend -> Fein -> Out stehen.
import json, os, sys, tempfile

class ParMode: CONSTANT = 0; EXPRESSION = 1
class Par:
    def __init__(self): self.val = None; self.mode = ParMode.CONSTANT
class Pars:
    def __getattr__(self, k): p = Par(); setattr(self, k, p); return p
class Conn:
    def __init__(self, owner): self.owner = owner; self.src = None
    @property
    def connections(self): return [c for o in NET.ops.values() for c in o.inputConnectors if c.src is self.owner]
    def connect(self, x):
        if isinstance(x, Conn): x.src = self.owner  # Ausgang -> Eingang
        else: self.src = x
class Op:
    def __init__(self, name, kind):
        self.name, self.kind, self.par, self.text = name, kind, Pars(), ''
        self.nodeX = self.nodeY = 0
        self.inputConnectors = [Conn(self), Conn(self)]
    @property
    def outputConnectors(self): return [OutConn(self)]
class OutConn:
    def __init__(self, o): self.o = o
    @property
    def connections(self): return [c for x in NET.ops.values() for c in x.inputConnectors if c.src is self.o]
class Net:
    def __init__(self): self.ops = {}
    def op(self, n): return self.ops.get(n)
    def create(self, kind, n): o = Op(n, kind); self.ops[n] = o; return o
NET = Net()
render = NET.create('render', 'Projektion_P1'); out = NET.create('out', 'Out')
out.inputConnectors[0].src = render

base = tempfile.mkdtemp()
os.makedirs(os.path.join(base, 'feinkorrektur'))
open(os.path.join(base, 'feinkorrektur', 'P1.frag'), 'w').write('// shader')
open(os.path.join(base, 'P1.png'), 'w').write('x')
data = {'projectors': [{'id': 'P1', 'maskFile': 'P1.png', 'warpShader': 'feinkorrektur/P1.frag'}]}
g = {'ParMode': ParMode, 'op': lambda p: NET, 'me': None, 'project': None, 'KALIB_NO_AUTORUN': True,
     'moviefileinTOP': 'moviefilein', 'multiplyTOP': 'multiply', 'glslTOP': 'glsl', 'textDAT': 'text',
     'print': lambda *a: sys.stderr.write(' '.join(map(str, a)) + '\n')}
exec(open('td/apply_calibration.py', encoding='utf-8').read(), g)
g['SETUP_MASKS'] = True; g['PROJEKTION_NAMES'] = {}
for _ in range(2):  # zweimal: zweiter Lauf darf nichts doppelt einfügen
    g['setup_masks'](NET, data, base)
    g['setup_warp'](NET, data, base)
chain, o = [], out
while o is not None: chain.append(o.name); o = o.inputConnectors[0].src
fein = NET.op('Fein_P1')
print(json.dumps({'chain': chain, 'ops': sorted(NET.ops), 'pixeldat': fein.par.pixeldat.val.name, 'text': NET.op('Fein_P1_frag').text}))
