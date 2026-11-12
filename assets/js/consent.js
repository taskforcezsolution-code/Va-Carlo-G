(()=>{const NAME="user_consent",box=document.getElementById("cc");if(!box)return;
 const read=()=>{const m=document.cookie.match(new RegExp("(?:^|; )"+NAME+"=([^;]*)"));let v=m?decodeURIComponent(m[1]):null;
  if(!v){try{v=localStorage.getItem(NAME)}catch(e){}}return v};          // localStorage fallback (e.g. file:// previews)
 const save=v=>{const d=new Date();d.setFullYear(d.getFullYear()+5);                       // expires in 5 years
  document.cookie=NAME+"="+encodeURIComponent(v)+"; expires="+d.toUTCString()+"; max-age="+60*60*24*365*5+"; path=/; SameSite=Lax"+(location.protocol==="https:"?"; Secure":"");
  try{localStorage.setItem(NAME,v)}catch(e){}};
 if(read()){box.remove();return}                                                                // already chose -> never show again
 const hide=()=>{box.classList.remove("show");document.body.classList.remove("cc-open");setTimeout(()=>box.remove(),700)};
 box.addEventListener("click",e=>{const b=e.target.closest("[data-cc]");if(b){save(b.dataset.cc);window.dispatchEvent(new CustomEvent("cookieconsent",{detail:b.dataset.cc}));hide();return}
  });                                          // privacy link is a placeholder
 const show=()=>{box.hidden=false;document.body.style.setProperty("--cc-h",box.offsetHeight+"px");document.body.classList.add("cc-open");requestAnimationFrame(()=>requestAnimationFrame(()=>box.classList.add("show")))};
 const wait=()=>document.getElementById("intro")?setTimeout(wait,300):setTimeout(show,500);    // appear after the intro has finished
 wait()})();
