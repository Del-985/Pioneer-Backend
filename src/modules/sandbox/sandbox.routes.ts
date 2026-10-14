import {Router} from 'express';
import {env} from '../../config/env.js';
import {requireAuth} from '../../middleware/auth.js';
import {assertPlatformPermission} from '../access/authorization.service.js';
import {createPayrollScenario} from './scenario.js';
export const sandboxRouter=Router();
sandboxRouter.use(requireAuth);
sandboxRouter.post('/scenarios',async(req,res)=>{
 if(env.APP_ENV!=='sandbox'){res.sendStatus(404);return;}
 await assertPlatformPermission(req.auth!.userId,'payroll.filing.prepare');
 const data=await createPayrollScenario(req.auth!.userId);
 res.status(201).json({data});
});
