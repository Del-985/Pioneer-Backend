import type { Request } from 'express';
import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { issueUserPasswordReset, listUserSessions, revokeAllUserSessions, revokeUserSession } from './admin-user-security.service.js';

export const adminUserSecurityRouter=Router({mergeParams:true});
function metadata(req:Request){return{ipAddress:req.ip??null,userAgent:req.get('user-agent')??null};}
adminUserSecurityRouter.get('/sessions',requireAuth,async(req,res)=>{const userId=requireRouteParam(req,'userId');res.json({data:await listUserSessions(req.auth!.userId,userId)});});
adminUserSecurityRouter.delete('/sessions/:sessionId',requireAuth,async(req,res)=>{const userId=requireRouteParam(req,'userId');const sessionId=requireRouteParam(req,'sessionId');await revokeUserSession(req.auth!.userId,userId,sessionId,metadata(req));res.status(204).end();});
adminUserSecurityRouter.post('/sessions/revoke-all',requireAuth,async(req,res)=>{const userId=requireRouteParam(req,'userId');res.json({data:{revoked:await revokeAllUserSessions(req.auth!.userId,userId,metadata(req))}});});
adminUserSecurityRouter.post('/password-reset',requireAuth,async(req,res)=>{const userId=requireRouteParam(req,'userId');res.status(202).json({data:await issueUserPasswordReset(req.auth!.userId,userId,metadata(req))});});
