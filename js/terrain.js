(async()=>{
const H=document.documentElement;if(H.classList.contains('lite')||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
try{const tc=document.createElement('canvas'),g=tc.getContext('webgl'),x=g&&g.getExtension('WEBGL_debug_renderer_info'),rn=x?String(g.getParameter(x.UNMASKED_RENDERER_WEBGL)):'';if(!g||/swiftshader|llvmpipe|software|basic render/i.test(rn))return}catch(e){return}
await new Promise(r=>{const go=()=>{['pointermove','scroll','touchstart','keydown'].forEach(t=>removeEventListener(t,go));(window.requestIdleCallback||setTimeout)(r,{timeout:1500})};['pointermove','scroll','touchstart','keydown'].forEach(t=>addEventListener(t,go,{once:true,passive:true}))});
const THREE=await import('three');const {SimplexNoise}=await import('three/addons/math/SimplexNoise.js');
// Point terrain background (ported from the pasted code)
const host=document.getElementById('tr');
if(host){try{
const VS='attribute vec3 aCol;attribute float aSize;attribute float aAlpha;uniform float uSize;uniform float uScale;uniform float uNear;uniform float uFar;uniform float uFade;varying vec3 vC;varying float vA;void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);float f=clamp((-mv.z-uNear)/(uFar-uNear),0.0,1.0);vC=aCol;vA=aAlpha*mix(1.0,1.0-uFade,f);gl_PointSize=max(uSize*aSize*uScale/max(-mv.z,0.1),1.0);gl_Position=projectionMatrix*mv;}';
const FS='uniform float uCore;uniform float uGain;varying vec3 vC;varying float vA;void main(){float d=length(gl_PointCoord-0.5)*2.0;if(d>1.0)discard;float a=1.0-smoothstep(uCore,1.0,d);gl_FragColor=vec4(vC,a*vA*uGain);}';
const R=new THREE.WebGLRenderer({antialias:true,alpha:true});R.setPixelRatio(Math.min(devicePixelRatio,1.5));host.appendChild(R.domElement);
const sc=new THREE.Scene(),cam=new THREE.PerspectiveCamera(45,1,.1,200);cam.position.set(0,2.6,6.4);cam.lookAt(0,.1,-2.6);
const GX=64,GZ=44,N=GX*GZ,geo=new THREE.BufferGeometry();
const mk=(k,f)=>{const a=new THREE.BufferAttribute(new Float32Array(N*k).fill(f),k);a.setUsage(THREE.DynamicDrawUsage);return a};
const pos=mk(3,0),col=mk(3,1),siz=mk(1,1),alp=mk(1,1);geo.setAttribute('position',pos);geo.setAttribute('aCol',col);geo.setAttribute('aSize',siz);geo.setAttribute('aAlpha',alp);
const mat=new THREE.ShaderMaterial({uniforms:{uSize:{value:.078},uScale:{value:300},uNear:{value:5},uFar:{value:19},uFade:{value:.9},uCore:{value:.4},uGain:{value:1}},vertexShader:VS,fragmentShader:FS,transparent:true,depthWrite:false,depthTest:false});
const pts=new THREE.Points(geo,mat);pts.frustumCulled=false;sc.add(pts);
function size(){const w=innerWidth,h=innerHeight;R.setSize(w,h,false);cam.aspect=w/h;cam.updateProjectionMatrix();mat.uniforms.uScale.value=R.domElement.height/(2*Math.tan(cam.fov*Math.PI/360))}
size();addEventListener('resize',size);
const rgb=h=>[(h>>16)/255,((h>>8)&255)/255,(h&255)/255],clamp=(x,a,b)=>Math.min(b,Math.max(a,x)),mix3=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
const ns=new SimplexNoise(),GXs=new Float32Array(N),GZs=new Float32Array(N);
for(let j=0;j<GZ;j++)for(let i=0;i<GX;i++){GXs[j*GX+i]=(i/(GX-1)-.5)*16;GZs[j*GX+i]=(j/(GZ-1))*12.4-9.4}
const pale=rgb(0xa9cdff),blue=rgb(0x0a6cff),ink=rgb(0x0b2f7a);
const rc=new THREE.Raycaster(),pl=new THREE.Plane(new THREE.Vector3(0,1,0),0),hit=new THREE.Vector3(),ndc=new THREE.Vector2();
let tx=0,ty=0,bx=0,bz=-1.5;addEventListener('pointermove',e=>{tx=e.clientX/innerWidth-.5;ty=e.clientY/innerHeight-.5});
const still=matchMedia('(prefers-reduced-motion: reduce)').matches;let drawn=false;const t0=performance.now();
const pa=pos.array,ca=col.array,sa=siz.array,aa=alp.array;
let last=0;function frame(now){requestAnimationFrame(frame);if(document.hidden||(still&&drawn)||now-last<33)return;last=now;drawn=true;const t=(now-t0)/1000;
cam.updateMatrixWorld();ndc.set(tx*2,-ty*2);rc.setFromCamera(ndc,cam);const h0=rc.ray.intersectPlane(pl,hit);const gx=h0?h0.x:bx,gz=h0?h0.z:bz;bx+=(gx-bx)*.12;bz+=(gz-bz)*.12;
for(let i=0;i<N;i++){const x=GXs[i],z=GZs[i];const h=.3*Math.sin(x*.75+t)*Math.cos(z*.62-t*.7)+.2*ns.noise3d(x*.32,z*.32,t*.22)+.07*Math.sin((x+z)*1.5-t*1.4);
const dx=x-bx,dz=z-bz,d2=dx*dx+dz*dz,bump=Math.exp(-d2/.9)*.95+Math.sin(Math.sqrt(d2)*5-t*4.5)*Math.exp(-d2/3)*.07,y=h+bump,tt=clamp((y+.35)/1.4,0,1);
const c=tt<.5?mix3(pale,blue,tt*2):mix3(blue,ink,(tt-.5)*2),i3=i*3;pa[i3]=x;pa[i3+1]=y;pa[i3+2]=z;ca[i3]=c[0];ca[i3+1]=c[1];ca[i3+2]=c[2];sa[i]=.75+tt;aa[i]=.5+tt*.45}
pos.needsUpdate=col.needsUpdate=siz.needsUpdate=alp.needsUpdate=true;R.render(sc,cam);if(!host.dataset.on){host.dataset.on=1;host.style.opacity=1}}
host.style.opacity=0;host.style.transition='opacity 1.2s ease';
requestAnimationFrame(frame);
}catch(e){console.warn('Terrain background unavailable',e)}}
})();
