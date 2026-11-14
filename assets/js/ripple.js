(async()=>{
const H=document.documentElement,host=document.getElementById('tr');
if(!host||H.classList.contains('lite')||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
// skip machines without a real graphics card (software rendering would hang the page)
try{const tc=document.createElement('canvas'),g=tc.getContext('webgl'),x=g&&g.getExtension('WEBGL_debug_renderer_info'),rn=x?String(g.getParameter(x.UNMASKED_RENDERER_WEBGL)):'';
 if(!g||(/swiftshader|llvmpipe|software|basic render/i.test(rn)&&!window.__rippleForce))return}catch(e){return}
// wait for the first real mouse movement, then load three.js while the browser is idle
await new Promise(r=>{const go=e=>{if(e.pointerType&&e.pointerType!=='mouse')return;removeEventListener('pointermove',go);(window.requestIdleCallback||setTimeout)(r,{timeout:1500})};addEventListener('pointermove',go,{passive:true})});
const THREE=await import('three');
const SCALE=.5,MAXT=6;           // render at half resolution, at most 6 ripples
const R=new THREE.WebGLRenderer({antialias:false,alpha:true,powerPreference:'low-power'});
R.setPixelRatio(1);host.appendChild(R.domElement);
const scene=new THREE.Scene(),taps=[];for(let i=0;i<MAXT;i++)taps.push(new THREE.Vector3(.5,.5,-99));
let ti=0,lastTap=-9,lx=.5,ly=.5;
const PAL={light:{c3:[.957,.918,.867],c2:[.863,.769,.651],c1:[.718,.553,.380],c4:[.98,.95,.91],spec:.2,h:.1},
           dark:{c3:[.20,.14,.10],c2:[.16,.11,.075],c1:[.43,.31,.22],c4:[.25,.18,.13],spec:.1,h:.07}};
const U={uTime:{value:0},uRes:{value:new THREE.Vector2(1,1)},uR:{value:taps},uC1:{value:new THREE.Vector3()},uC2:{value:new THREE.Vector3()},uC3:{value:new THREE.Vector3()},uC4:{value:new THREE.Vector3()},uSpec:{value:.2},uH:{value:.1}};
const VERT='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}';
const FRAG=`varying vec2 vUv;uniform float uTime;uniform vec2 uRes;uniform vec3 uR[${MAXT}];uniform vec3 uC1,uC2,uC3,uC4;uniform float uSpec,uH;
float asp(){return uRes.x/uRes.y;}
float height(vec2 p){float h=0.0;for(int i=0;i<${MAXT};i++){float age=uTime-uR[i].z;if(age<0.0||age>4.5)continue;
 vec2 c=(uR[i].xy-0.5)*vec2(asp(),1.0);float d=length(p-c);float x=d-age*0.3;
 h+=sin(x*52.0)*exp(-x*x*140.0)*exp(-age*0.8)/(1.0+d*3.0);}return h;}
void main(){vec2 p=(vUv-0.5)*vec2(asp(),1.0);float e=0.006;float h0=height(p);
 vec2 g=vec2(height(p+vec2(e,0.0))-h0,height(p+vec2(0.0,e))-h0)/e;vec2 uv2=vUv+g*0.004;
 vec3 col=mix(uC3,uC2,smoothstep(0.1,1.0,uv2.y*0.8+uv2.x*0.3));
 col=mix(col,uC4,smoothstep(0.55,1.0,1.0-uv2.y)*0.5);
 vec3 n=normalize(vec3(-g*0.06,1.0));float diff=dot(n,normalize(vec3(-0.4,0.6,0.7)));
 col=mix(col,uC1,clamp(0.5-diff*0.9+0.2,0.0,1.0)*0.3*smoothstep(0.0,0.2,abs(h0)*4.0));
 col+=pow(max(diff,0.0),22.0)*uSpec;col+=h0*uH;gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);}`;
const mat=new THREE.ShaderMaterial({uniforms:U,vertexShader:VERT,fragmentShader:FRAG});mat.precision='mediump';
const cam=new THREE.OrthographicCamera(-1,1,1,-1,0,1),mesh=new THREE.Mesh(new THREE.PlaneGeometry(2,2),mat);mesh.frustumCulled=false;scene.add(mesh);
const palette=()=>{const p=H.classList.contains('dark')?PAL.dark:PAL.light;U.uC1.value.set(...p.c1);U.uC2.value.set(...p.c2);U.uC3.value.set(...p.c3);U.uC4.value.set(...p.c4);U.uSpec.value=p.spec;U.uH.value=p.h};
const size=()=>{const w=Math.max(2,Math.ceil(innerWidth*SCALE)),h=Math.max(2,Math.ceil(innerHeight*SCALE));R.setSize(w,h,false);U.uRes.value.set(w,h)};
palette();size();
let acc=0,last=0,raf=0,tx=.5,ty=.5;
const draw=()=>R.render(scene,cam);
function frame(now){raf=0;if(document.hidden)return;
 if(now-last<30){raf=requestAnimationFrame(frame);return}          // about 33 fps is plenty for soft ripples
 acc+=Math.min(.06,(now-last)/1000);last=now;U.uTime.value=acc;draw();
 if(acc-lastTap<4.6)raf=requestAnimationFrame(frame);}               // stop completely when the water is calm
const kick=()=>{if(!raf){last=performance.now();raf=requestAnimationFrame(frame)}};
addEventListener('pointermove',e=>{if(e.pointerType&&e.pointerType!=='mouse')return;tx=e.clientX/innerWidth;ty=1-e.clientY/innerHeight;
 if(Math.hypot(tx-lx,ty-ly)>.012&&acc-lastTap>.09){taps[ti%MAXT].set(tx,ty,acc);ti++;lastTap=acc;lx=tx;ly=ty;kick()}},{passive:true});
addEventListener('resize',()=>{size();draw()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&acc-lastTap<4.6)kick()});
new MutationObserver(()=>{palette();draw()}).observe(H,{attributes:true,attributeFilter:['class']});
draw();R.domElement.classList.add('on');
})();
