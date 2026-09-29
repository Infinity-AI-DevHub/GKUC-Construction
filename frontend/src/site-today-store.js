const DB_NAME='gkuc-site-today-v1';

function database(){
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open(DB_NAME,1);
    request.onupgradeneeded=()=>request.result.createObjectStore('drafts');
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}

async function operate(mode,action){
  const db=await database();
  try{return await new Promise((resolve,reject)=>{
    const transaction=db.transaction('drafts',mode);
    const request=action(transaction.objectStore('drafts'));
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });}finally{db.close();}
}

export const draftKey=(userId,projectId,date)=>`${userId}:${projectId}:${date}`;
export const readDraft=key=>operate('readonly',store=>store.get(key));
export const saveDraft=(key,value)=>operate('readwrite',store=>store.put(value,key));
export const removeDraft=key=>operate('readwrite',store=>store.delete(key));

export function completeness(draft){
  return [Boolean(draft.projectId),Number(draft.workforce)>=0&&draft.workforce!=='',
    (draft.materials||[]).length>0&&draft.materials.every(row=>Number(row.quantity)>=0),
    String(draft.work||'').trim().length>=3,(draft.photos||[]).length>0].filter(Boolean).length;
}
