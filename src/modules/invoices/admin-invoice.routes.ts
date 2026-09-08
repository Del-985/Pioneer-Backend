import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createInvoiceSchema, invoiceListQuerySchema, updateInvoiceSchema } from './admin-invoice.schemas.js';
import { createInvoice, getInvoice, listInvoices, updateInvoice } from './admin-invoice.service.js';

export const adminInvoiceRouter = Router({ mergeParams: true });
adminInvoiceRouter.get('/', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listInvoices(req.auth!.userId,businessUnitId,invoiceListQuerySchema.parse(req.query)));});
adminInvoiceRouter.post('/', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.status(201).json({data:await createInvoice(req.auth!.userId,businessUnitId,createInvoiceSchema.parse(req.body))});});
adminInvoiceRouter.get('/:invoiceId', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const invoiceId=requireRouteParam(req,'invoiceId');res.json({data:await getInvoice(req.auth!.userId,businessUnitId,invoiceId)});});
adminInvoiceRouter.patch('/:invoiceId', requireAuth, async (req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const invoiceId=requireRouteParam(req,'invoiceId');res.json({data:await updateInvoice(req.auth!.userId,businessUnitId,invoiceId,updateInvoiceSchema.parse(req.body))});});
