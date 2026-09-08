import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createIntercompanySchema, intercompanyListQuerySchema, postIntercompanySchema, updateIntercompanySchema } from './admin-intercompany.schemas.js';
import { createIntercompany, listIntercompany, postIntercompany, updateIntercompany } from './admin-intercompany.service.js';

export const adminIntercompanyRouter=Router();
adminIntercompanyRouter.get('/',requireAuth,async(req,res)=>{res.json(await listIntercompany(req.auth!.userId,intercompanyListQuerySchema.parse(req.query)));});
adminIntercompanyRouter.post('/',requireAuth,async(req,res)=>{res.status(201).json({data:await createIntercompany(req.auth!.userId,createIntercompanySchema.parse(req.body))});});
adminIntercompanyRouter.patch('/:intercompanyId',requireAuth,async(req,res)=>{const intercompanyId=requireRouteParam(req,'intercompanyId');res.json({data:await updateIntercompany(req.auth!.userId,intercompanyId,updateIntercompanySchema.parse(req.body))});});
adminIntercompanyRouter.post('/:intercompanyId/post',requireAuth,async(req,res)=>{const intercompanyId=requireRouteParam(req,'intercompanyId');res.json({data:await postIntercompany(req.auth!.userId,intercompanyId,postIntercompanySchema.parse(req.body))});});
