import {env} from '../config/env.js';
import {pool} from './pool.js';
import {createPayrollScenario} from '../modules/sandbox/scenario.js';
try{
 if(env.APP_ENV!=='sandbox')throw new Error('Sandbox startup requires APP_ENV=sandbox');
 const existing=await pool.query("SELECT id FROM legal_entities WHERE slug LIKE 'practice-%' LIMIT 1");
 if(!existing.rowCount){
  const manager=await pool.query('SELECT id FROM users WHERE email=$1',[env.BOOTSTRAP_ADMIN_EMAIL]);
  if(!manager.rows[0])throw new Error('Bootstrap a sandbox administrator first');
  await createPayrollScenario(manager.rows[0].id);
 }
}finally{await pool.end();}
