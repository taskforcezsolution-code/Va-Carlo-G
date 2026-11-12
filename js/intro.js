(()=>{const I=document.getElementById("intro"),H=document.documentElement;
const done=()=>{I.remove();H.classList.remove("intro-on");document.querySelectorAll(".ia-fly").forEach(e=>e.remove())};
if(!H.classList.contains("intro-on")){done();return}
setTimeout(done,13000);I.addEventListener("click",done);   // click anywhere to skip
const $=q=>I.querySelector(q),scene=$(".scene"),flip=$(".flip"),pface=$(".pface"),ref=$(".ref"),tag=$(".tag"),stage=$(".stage");
let ph="";
const start=()=>{
 const av0=document.querySelector(".avatar");if(av0){const c=getComputedStyle(av0);ph=c.backgroundImage;if(ph&&ph!=="none"){pface.style.backgroundImage=ph;pface.style.backgroundSize=c.backgroundSize;pface.style.backgroundPosition=c.backgroundPosition}}
 requestAnimationFrame(()=>requestAnimationFrame(()=>scene.classList.add("in")));
 // logo stays ~4 seconds, then flips to the profile picture
 setTimeout(()=>flip.classList.add("back"),3800);
 // sentence slides out of the picture's right side
 setTimeout(()=>{const w=tag.parentElement.offsetWidth;stage.style.transform=`translateX(${-w/2}px)`;tag.classList.add("show")},5000);
 // sentence slides back into the picture
 setTimeout(()=>{tag.classList.remove("show");stage.style.transform="none"},8400);
 // 3 seconds later the picture settles into the dashboard avatar (same size, border, shadow and crop)
 setTimeout(()=>{
  const av=document.querySelector(".avatar"),T=av.getBoundingClientRect(),R=ref.getBoundingClientRect(),c=getComputedStyle(av);
  const fly=document.createElement("div");fly.className="ia-fly";
  const bw=c.borderTopWidth,bc=c.borderTopColor,bs=c.borderTopStyle==="none"?"solid":c.borderTopStyle;
  fly.style.cssText+=`left:${R.left}px;top:${R.top}px;width:${R.width}px;height:${R.height}px;border:6px solid #eef0f4;background-image:${c.backgroundImage};background-size:${c.backgroundSize};background-position:${c.backgroundPosition};background-repeat:${c.backgroundRepeat};background-color:${c.backgroundColor};border-radius:50%`;
  document.body.appendChild(fly);scene.style.visibility="hidden";I.classList.add("go");
  fly.animate([{left:R.left+"px",top:R.top+"px",width:R.width+"px",height:R.height+"px",borderWidth:"6px",borderColor:"#eef0f4",boxShadow:"0 0 0 rgba(0,0,0,0)"},
               {left:T.left+"px",top:T.top+"px",width:T.width+"px",height:T.height+"px",borderWidth:bw,borderColor:bc,boxShadow:c.boxShadow}],
              {duration:1300,easing:"cubic-bezier(.65,0,.25,1)",fill:"forwards"});
  setTimeout(()=>H.classList.remove("intro-on"),1300);
 },9500);
};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();
