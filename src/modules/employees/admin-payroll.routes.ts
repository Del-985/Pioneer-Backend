import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requireRouteParam } from '../../lib/route-param.js';
import {
  listPayrollRates,setPayrollRate,getPayrollAccounts,
  preparePayroll,approvePayroll,voidPayroll,postPayroll,
  listPayroll,getPayroll,rateSchema,periodSchema,journalSchema,
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
