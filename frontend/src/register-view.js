import {useEffect,useState} from 'react';

export function useRegisterView(key,defaults) {
  const [view,setView]=useState(()=>{
    try { return {...defaults,...JSON.parse(sessionStorage.getItem(key)||'{}')}; }
    catch { return defaults; }
  });
  useEffect(()=>{
    try { sessionStorage.setItem(key,JSON.stringify(view)); } catch {}
  },[key,view]);
  const update=(field,value)=>setView(current=>({...current,[field]:value}));
  return [view,update];
}

export function useRegisterScroll(key,ready,skip=false) {
  useEffect(()=>{
    if (!ready || skip) return undefined;
    let previous=0;
    try { previous=Number(sessionStorage.getItem(key))||0; } catch {}
    let position=previous;
    const frame=requestAnimationFrame(()=>{
      if (previous) window.scrollTo({top:previous,behavior:'instant'});
      position=window.scrollY;
    });
    const record=()=>{position=window.scrollY;};
    const persist=()=>{
      try { sessionStorage.setItem(key,String(position)); } catch {}
    };
    window.addEventListener('scroll',record,{passive:true});
    window.addEventListener('pagehide',persist);
    return ()=>{
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll',record);
      window.removeEventListener('pagehide',persist);
      persist();
    };
  },[key,ready,skip]);
}
