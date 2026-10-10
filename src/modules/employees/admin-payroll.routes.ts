import {
  prepareProviderSchema, submitProviderSchema, importProviderSchema,
  prepareProvider,providerDetail,providerList,providerExport,
  recordProviderSubmission,importProviderResults,
} from './payroll-provider.service.js';
import {
  adjustmentSchema,adjustmentListSchema,adjustmentJournalSchema,
  listAdjustments,createAdjustment,approveAdjustment,voidAdjustment,
  postAdjustment,reverseAdjustment,getAdjustmentEvents,
} from './payroll-adjustments.service.js';
import {z} from 'zod';
import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireRouteParam } from '../../lib/route-param.js';
import {
  listPayrollRates,setPayrollRate,getPayrollAccounts,
  preparePayroll,approvePayroll,voidPayroll,postPayroll,
  listPayroll,getPayroll,payrollJobCosts,rateSchema,periodSchema,journalSchema,
} from './payroll.service.js';

export const adminPayrollRouter=Router({mergeParams:true});
adminPayrollRouter.use(requireAuth);
const unit=(req:any)=>requireRouteParam(req,'businessUnitId');
adminPayrollRouter.get('/rates',async(req,res)=>{
  res.json(await listPayrollRates(req.auth!.userId,unit(req)));
});
adminPayrollRouter.post('/rates',async(req,res)=>{
  res.status(201).json(await setPayrollRate(req.auth!.userId,unit(req),rateSchema.parse(req.body)));
});
adminPayrollRouter.get('/accounts',async(req,res)=>{
  res.json(await getPayrollAccounts(req.auth!.userId,unit(req)));
});
adminPayrollRouter.get('/runs',async(req,res)=>{
  res.json(await listPayroll(req.auth!.userId,unit(req)));
});
adminPayrollRouter.post('/runs',async(req,res)=>{
  res.status(201).json(await preparePayroll(req.auth!.userId,unit(req),periodSchema.parse(req.body)));
});
adminPayrollRouter.get('/runs/:runId',async(req,res)=>{
  res.json(await getPayroll(req.auth!.userId,unit(req),requireRouteParam(req,'runId')));
});
adminPayrollRouter.post('/runs/:runId/approve',async(req,res)=>{
  res.json(await approvePayroll(req.auth!.userId,unit(req),requireRouteParam(req,'runId')));
});
adminPayrollRouter.post('/runs/:runId/void',async(req,res)=>{
  res.json(await voidPayroll(req.auth!.userId,unit(req),requireRouteParam(req,'runId')));
});
adminPayrollRouter.post('/runs/:runId/post',async(req,res)=>{
  res.json(await postPayroll(req.auth!.userId,unit(req),
    requireRouteParam(req,'runId'),
    req.body && Object.keys(req.body).length?journalSchema.parse(req.body):undefined));
});

adminPayrollRouter.get('/labor-costs',async(req,res)=>{
  res.json(await payrollJobCosts(req.auth!.userId,unit(req)));
});

adminPayrollRouter.get('/adjustments',async(req,res)=>{
  res.json(await listAdjustments(req.auth!.userId,unit(req),adjustmentListSchema.parse(req.query)));
});
adminPayrollRouter.post('/adjustments',async(req,res)=>{
  res.status(201).json(await createAdjustment(req.auth!.userId,unit(req),
    adjustmentSchema.parse(req.body)));
});
adminPayrollRouter.post('/adjustments/:adjustmentId/approve',async(req,res)=>{
  res.json(await approveAdjustment(req.auth!.userId,unit(req),
    requireRouteParam(req,'adjustmentId')));
});
adminPayrollRouter.post('/adjustments/:adjustmentId/void',async(req,res)=>{
  res.json(await voidAdjustment(req.auth!.userId,unit(req),
    requireRouteParam(req,'adjustmentId')));
});
adminPayrollRouter.post('/adjustments/:adjustmentId/post',async(req,res)=>{
  res.json(await postAdjustment(req.auth!.userId,unit(req),
    requireRouteParam(req,'adjustmentId'),
    adjustmentJournalSchema.parse(req.body??{})));
});
adminPayrollRouter.post('/adjustments/:adjustmentId/reverse',async(req,res)=>{
  const input=z.object({
    requestKey:z.string().uuid(),
    reason:z.string().trim().min(12).max(2000),
  }).parse(req.body);
  res.json(await reverseAdjustment(req.auth!.userId,unit(req),
    requireRouteParam(req,'adjustmentId'),input.reason,input.requestKey));
});
adminPayrollRouter.get('/adjustments/:adjustmentId/events',async(req,res)=>{
  res.json(await getAdjustmentEvents(req.auth!.userId,unit(req),
    requireRouteParam(req,'adjustmentId')));
});

adminPayrollRouter.get('/provider-batches',async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  res.json(await providerList(req.auth!.userId,unit(req)));
});
adminPayrollRouter.post('/runs/:runId/provider/prepare',async(req,res)=>{
  const input=prepareProviderSchema.parse(req.body);
  res.status(201).json(await prepareProvider(req.auth!.userId,unit(req),
    requireRouteParam(req,'runId'),input));
});
adminPayrollRouter.get('/runs/:runId/provider',async(req,res)=>{
  res.setHeader('Cache-Control','private, no-store');
  res.json(await providerDetail(req.auth!.userId,unit(req),
    requireRouteParam(req,'runId')));
});
adminPayrollRouter.get('/runs/:runId/provider/export',async(req,res)=>{
  const file=await providerExport(req.auth!.userId,unit(req),
    requireRouteParam(req,'runId'));
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="'+file.filename+'"');
  res.status(200).send(file.content);
});
adminPayrollRouter.post('/runs/:runId/provider/submitted',async(req,res)=>{
  const input=submitProviderSchema.parse(req.body);
  res.json(await recordProviderSubmission(req.auth!.userId,unit(req),
    requireRouteParam(req,'runId'),input));
});
adminPayrollRouter.post('/runs/:runId/provider/import',async(req,res)=>{
  const input=importProviderSchema.parse(req.body);
  res.json(await importProviderResults(req.auth!.userId,unit(req),
    requireRouteParam(req,'runId'),input));
});
