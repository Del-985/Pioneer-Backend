import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createPaymentSchema, paymentListQuerySchema, updatePaymentSchema } from './admin-payment.schemas.js';
import { createPayment, listPayments, updatePayment } from './admin-payment.service.js';

export const adminPaymentRouter = Router({ mergeParams: true });
adminPaymentRouter.get('/', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listPayments(req.auth!.userId,businessUnitId,paymentListQuerySchema.parse(req.query)));});
adminPaymentRouter.post('/', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.status(201).json({data:await createPayment(req.auth!.userId,businessUnitId,createPaymentSchema.parse(req.body))});});
adminPaymentRouter.patch('/:paymentId', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const paymentId=requireRouteParam(req,'paymentId');res.json({data:await updatePayment(req.auth!.userId,businessUnitId,paymentId,updatePaymentSchema.parse(req.body))});});
