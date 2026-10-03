"""Synthesizes the dramatic 20s soundtrack. Usage: make_music.py OUTDIR (writes music_raw.wav)."""
import numpy as np, wave, sys
S=sys.argv[1]
sr=44100; D=20; t=np.arange(int(sr*D))/sr
def note(f): return 440*2**((f-69)/12)
chords=[[45,52,57,60],[41,48,53,57],[48,55,60,64],[43,50,55,59]]  # Am F C G
pad=np.zeros_like(t)
for k,ch in enumerate(chords):
    t0,t1=k*5,(k+1)*5
    env=np.clip((t-t0)/1.5,0,1)*np.clip((t1+0.8-t)/1.5,0,1)*((t>=t0)&(t<t1+0.8))
    for n in ch:
        for det in (-0.07,0,0.07):
            f=note(n)*(1+det*0.01*10)
            for h,a in ((1,1),(2,.5),(3,.3),(4,.15)):
                pad+=env*a*np.sin(2*np.pi*f*h*t)*0.025
swell=0.45+0.55*(t/D)
pad*=swell
# heartbeat pulse
kick=np.zeros_like(t)
for b in np.arange(1,D-0.5,1.0 if True else 0.5):
    for off,amp in ((0,1.0),(0.28,0.6)):
        s=int((b+off)*sr); L=int(0.35*sr)
        if s+L>len(t): continue
        tt=np.arange(L)/sr; f=55*np.exp(-tt*9)+38
        kick[s:s+L]+=amp*np.sin(2*np.pi*np.cumsum(f)/sr)*np.exp(-tt*9)
kick*=0.5*np.clip(t/4,0,1)*(0.6+0.4*(t/D))
# riser
rng=np.random.default_rng(1)
noise=rng.standard_normal(len(t)); 
ris=np.convolve(noise,np.ones(40)/40,'same')*np.clip((t-15)/4,0,1)**2*0.5*(t<19.2)
# high arpeggio late
arp=np.zeros_like(t)
for i,tt in enumerate(np.arange(10,19,0.5)):
    n=[69,72,76,72][i%4]; s=int(tt*sr); L=int(0.6*sr)
    if s+L>len(t): break
    x=np.arange(L)/sr; arp[s:s+L]+=np.sin(2*np.pi*note(n)*x)*np.exp(-x*4)*0.05
mix=pad+kick+ris+arp
mix*=np.clip(t/1.0,0,1)*np.clip((D-t)/1.5,0,1)
mix/=np.abs(mix).max()*1.1
st=np.stack([mix,np.roll(mix,60)],1)
with wave.open(S+"/music_raw.wav","wb") as w:
    w.setnchannels(2);w.setsampwidth(2);w.setframerate(sr);w.writeframes((st*32767).astype('<i2').tobytes())
