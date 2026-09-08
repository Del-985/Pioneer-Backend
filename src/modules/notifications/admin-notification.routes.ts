import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { notificationActionSchema, notificationListQuerySchema } from './admin-notification.schemas.js';
import { listNotifications, manageNotification } from './admin-notification.service.js';

export const adminNotificationRouter=Router();
adminNotificationRouter.get('/',requireAuth,async(req,res)=>{res.json(await listNotifications(req.auth!.userId,notificationListQuerySchema.parse(req.query)));});
adminNotificationRouter.post('/:notificationId/action',requireAuth,async(req,res)=>{const notificationId=requireRouteParam(req,'notificationId');res.json({data:await manageNotification(req.auth!.userId,notificationId,notificationActionSchema.parse(req.body))});});
