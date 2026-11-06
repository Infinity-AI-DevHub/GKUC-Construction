import {pausedApiFeature,normalizedFeaturePath,PAUSE_ERROR,PAUSE_DETAIL,PAUSE_SOLUTION} from './temporary-features.mjs';
export function temporaryFeatureMiddleware(req,res,next) {
  const feature=pausedApiFeature(req.originalUrl||req.url)||(
    normalizedFeaturePath(req.originalUrl||req.url)==='/document-download-tickets'?pausedApiFeature(req.body?.path):null);
  if(!feature)return next();
  res.setHeader('Cache-Control','no-store');
  return res.status(423).json({code:'FEATURE_TEMPORARILY_DISABLED',feature,error:PAUSE_ERROR,detail:PAUSE_DETAIL,solution:PAUSE_SOLUTION});
}
