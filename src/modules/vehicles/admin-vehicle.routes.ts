import { Router } from 'express';
import { requireRouteParam } from '../../lib/route-param.js';
import { requireAuth } from '../../middleware/auth.js';
import { createVehicleSchema, updateVehicleSchema, vehicleListQuerySchema } from './admin-vehicle.schemas.js';
import { createVehicle, listVehicles, updateVehicle } from './admin-vehicle.service.js';

export const adminVehicleRouter=Router({mergeParams:true});
adminVehicleRouter.get('/',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.json(await listVehicles(req.auth!.userId,businessUnitId,vehicleListQuerySchema.parse(req.query)));});
adminVehicleRouter.post('/',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');res.status(201).json({data:await createVehicle(req.auth!.userId,businessUnitId,createVehicleSchema.parse(req.body))});});
adminVehicleRouter.patch('/:vehicleId',requireAuth,async(req,res)=>{const businessUnitId=requireRouteParam(req,'businessUnitId');const vehicleId=requireRouteParam(req,'vehicleId');res.json({data:await updateVehicle(req.auth!.userId,businessUnitId,vehicleId,updateVehicleSchema.parse(req.body))});});
