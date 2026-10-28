/** Express resolves req.ip lazily; completed upload requests can lose their socket. */
export function captureRequestAddress(req,res,next){
  const address=req.ip;
  // Resolve once using Express's configured trust-proxy rules, never raw headers.
  Object.defineProperty(req,'ip',{value:address,enumerable:true,configurable:true});
  next();
}
