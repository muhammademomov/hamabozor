"""Weather product ad: one product photo -> 20s vertical (9:16) video.
Rain -> snow -> sun, product unchanged, dramatic music.

Usage: python video/make_weather_ad.py PHOTO.jpg OUT.mp4 [--crop CX CY CW CH]
       [--t1 ДОЖДЬ --t2 СНЕГ --t3 СОЛНЦЕ --end1 "..." --end2 "..."]
Needs: numpy, pillow, ffmpeg (installed by video/setup.sh).
"""
import numpy as np, subprocess, math, random, sys, os, argparse, tempfile
from PIL import Image, ImageDraw, ImageFont, ImageFilter
ap=argparse.ArgumentParser()
ap.add_argument("photo"); ap.add_argument("out")
ap.add_argument("--crop",nargs=4,type=float,default=None,help="center x, center y, width, height of the 9:16 crop in source pixels")
ap.add_argument("--t1",default="ДОЖДЬ"); ap.add_argument("--t2",default="СНЕГ"); ap.add_argument("--t3",default="СОЛНЦЕ")
ap.add_argument("--end1",default="Погода меняется."); ap.add_argument("--end2",default="Рюкзак — нет.")
args=ap.parse_args()
SRC=args.photo
S=tempfile.mkdtemp()
subprocess.run([sys.executable,os.path.join(os.path.dirname(os.path.abspath(__file__)),"make_music.py"),S],check=True)
subprocess.run(["ffmpeg","-y","-loglevel","error","-i",S+"/music_raw.wav","-af","aecho=0.8:0.7:90|180:0.35|0.25,loudnorm=I=-16",S+"/music.wav"],check=True)
W,H,FPS,DUR=1080,1920,30,20
N=FPS*DUR
img=Image.open(SRC).convert("RGB")
if args.crop: CROP=args.crop
else:  # largest 9:16 window, centered
    ch_=img.height; cw_=ch_*9/16
    if cw_>img.width: cw_=img.width; ch_=cw_*16/9
    CROP=(img.width/2,img.height/2,cw_,ch_)
random.seed(7); np.random.seed(7)

def ss(x): x=min(max(x,0),1); return x*x*(3-2*x)
def weights(t):
    # rain 0-6, snow 6-12, sun 12-20, 1.2s crossfades
    f=1.2
    r=1-ss((t-(6-f/2))/f)
    s=ss((t-(6-f/2))/f)*(1-ss((t-(12-f/2))/f))
    u=ss((t-(12-f/2))/f)
    return r,s,u
# grade per scene: (mult rgb, add rgb, saturation)
G={'rain':((0.62,0.72,0.88),(-6,0,10),0.55),
   'snow':((0.95,1.02,1.12),(8,12,22),0.7),
   'sun':((1.12,1.04,0.88),(10,4,-6),1.15)}

# particles
rain=[[random.uniform(0,W),random.uniform(0,H),random.uniform(2200,3200),random.uniform(40,110),random.uniform(0.3,1)] for _ in range(320)]
snow=[[random.uniform(0,W),random.uniform(0,H),random.uniform(90,260),random.uniform(2,8),random.uniform(0,6.28)] for _ in range(260)]

font=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",78)
font2=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",44)

def base(t):
    z=1.0+0.16*(t/DUR)  # slow push-in
    cw=CROP[2]/z; ch=CROP[3]/z
    cx=CROP[0]+14*math.sin(t*0.5); cy=CROP[1]+6*math.cos(t*0.4)
    box=(cx-cw/2,cy-ch/2,cx+cw/2,cy+ch/2)
    box=(max(0,box[0]),max(0,box[1]),min(img.width,box[2]),min(img.height,box[3]))
    return img.resize((W,H),Image.LANCZOS,box=box)

vign=np.zeros((H,W),np.float32)
yy,xx=np.mgrid[0:H,0:W]
vign=1-0.55*(((xx-W/2)/(W/2))**2+((yy-H/2)/(H/2))**2)/2
vign=np.clip(vign,0.35,1)[...,None].astype(np.float32)

sunx,suny=W*0.85,H*0.08
sunglow=np.exp(-(((xx-sunx)**2+(yy-suny)**2)/(2*(520**2)))).astype(np.float32)[...,None]

def text_layer(t):
    lay=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(lay)
    def put(txt,t0,t1,y,f,col=(255,255,255)):
        a=min(ss((t-t0)/0.6),1-ss((t-(t1-0.6))/0.6))
        if a<=0: return
        w=d.textlength(txt,font=f)
        d.text(((W-w)/2,y),txt,font=f,fill=col+(int(255*a),),stroke_width=2,stroke_fill=(0,0,0,int(160*a)))
    put(args.t1,0.4,5.6,1560,font)
    put(args.t2,6.4,11.6,1560,font)
    put(args.t3,12.4,17.6,1560,font)
    put(args.end1,17.6,20,1500,font)
    put(args.end2,18.2,20,1610,font)
    return lay

proc=subprocess.Popen(["ffmpeg","-y","-loglevel","error","-f","rawvideo","-pix_fmt","rgb24","-s",f"{W}x{H}","-r",str(FPS),"-i","-",
  "-i",S+"/music.wav","-c:v","libx264","-preset","medium","-crf","18","-pix_fmt","yuv420p","-c:a","aac","-b:a","192k","-shortest",args.out],stdin=subprocess.PIPE)

for i in range(N):
    t=i/FPS
    wr,ws,wu=weights(t)
    a=np.asarray(base(t),dtype=np.float32)
    # grade blend
    mult=np.zeros(3);add=np.zeros(3);sat=0
    for w,k in ((wr,'rain'),(ws,'snow'),(wu,'sun')):
        m,ad,sa=G[k]; mult+=w*np.array(m); add+=w*np.array(ad); sat+=w*sa
    gray=a.mean(axis=2,keepdims=True)
    a=gray+(a-gray)*sat
    a=a*mult+add
    # sun glow
    a+=wu*sunglow*np.array([120,85,30],np.float32)*(0.85+0.15*math.sin(t*2))
    # fog for snow
    a+=ws*18
    a*=vign*(1-0.25*wr)+0.0
    a=np.clip(a,0,255)
    # particles
    lay=Image.new("RGBA",(W,H),(0,0,0,0)); d=ImageDraw.Draw(lay)
    if wr>0.01:
        for p in rain:
            y=(p[1]+p[2]*t)%(H+200)-100; x=(p[0]-0.25*p[2]*t)%(W+200)
            d.line([(x,y),(x-0.25*p[3],y-p[3])],fill=(200,215,235,int(150*p[4]*wr)),width=2 if p[4]>0.6 else 1)
    if ws>0.01:
        for p in snow:
            y=(p[1]+p[2]*t)%(H+40)-20; x=(p[0]+40*math.sin(t*0.8+p[4]))%W
            r=p[3]; d.ellipse([x-r,y-r,x+r,y+r],fill=(255,255,255,int(210*ws*min(1,r/5+0.3))))
    lay=lay.filter(ImageFilter.GaussianBlur(0.7))
    out=Image.fromarray(a.astype(np.uint8)).convert("RGBA")
    out=Image.alpha_composite(out,lay); out=Image.alpha_composite(out,text_layer(t))
    # fade in/out
    f=min(ss(t/0.8),1-ss((t-(DUR-0.8))/0.8))
    arr=np.asarray(out.convert("RGB"),dtype=np.float32)*f
    proc.stdin.write(arr.astype(np.uint8).tobytes())
proc.stdin.close(); proc.wait(); print("done")
