import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  createExpenseSchema, createRevenueSchema, expenseListQuerySchema, postExpenseSchema,
  postRevenueSchema, revenueListQuerySchema, updateExpenseSchema, updateRevenueSchema,
} from './admin-ledger-record.schemas.js';
import {
  createExpense, createRevenue, listExpenses, listRevenue, postExpense, postRevenue,
  updateExpense, updateRevenue,
} from './admin-ledger-record.service.js';

export const adminLedgerRecordRouter=Router({mergeParams:true});
adminLedgerRecordRouter.get('/expenses',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listExpenses(req.auth!.userId,businessUnitId,expenseListQuerySchema.parse(req.query)));});
adminLedgerRecordRouter.post('/expenses',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.status(201).json({data:await createExpense(req.auth!.userId,businessUnitId,createExpenseSchema.parse(req.body))});});
adminLedgerRecordRouter.patch('/expenses/:expenseId',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const expenseId=requireRouteParam(req,'expenseId');res.json({data:await updateExpense(req.auth!.userId,businessUnitId,expenseId,updateExpenseSchema.parse(req.body))});});
adminLedgerRecordRouter.post('/expenses/:expenseId/post',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const expenseId=requireRouteParam(req,'expenseId');res.json({data:await postExpense(req.auth!.userId,businessUnitId,expenseId,postExpenseSchema.parse(req.body))});});
adminLedgerRecordRouter.get('/revenue',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listRevenue(req.auth!.userId,businessUnitId,revenueListQuerySchema.parse(req.query)));});
adminLedgerRecordRouter.post('/revenue',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.status(201).json({data:await createRevenue(req.auth!.userId,businessUnitId,createRevenueSchema.parse(req.body))});});
adminLedgerRecordRouter.patch('/revenue/:revenueId',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const revenueId=requireRouteParam(req,'revenueId');res.json({data:await updateRevenue(req.auth!.userId,businessUnitId,revenueId,updateRevenueSchema.parse(req.body))});});
adminLedgerRecordRouter.post('/revenue/:revenueId/post',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const revenueId=requireRouteParam(req,'revenueId');res.json({data:await postRevenue(req.auth!.userId,businessUnitId,revenueId,postRevenueSchema.parse(req.body))});});
