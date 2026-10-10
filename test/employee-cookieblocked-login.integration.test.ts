import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test,{after} from 'node:test';
import type {AddressInfo} from 'node:net';
import {app} from '../src/app.js';
import {pool} from '../src/db/pool.js';
import {hashPassword} from '../src/modules/auth/password.js';
import {authenticateSessionToken} from '../src/modules/auth/auth.service.js';

const id={entity:randomUUID(),unit:randomUUID(),worker:randomUUID(),
  manager:randomUUID(),employee:randomUUID()};
const origin='https://employee.pioneeroutdoorservices.com';
const password='Secure-test-password-20!';
let server:ReturnType<typeof app.listen>|null=null;

async function call(base:string,path:string,opts:RequestInit={}){
  return fetch(base+path,{
    ...opts,
    headers:{origin,...opts.headers},
  });
}

after(async()=>{
  if(server)await new Promise<void>((done,reject)=>{
    server!.close(err=>err?reject(err):done());
  });
  try{
    await pool.query('DELETE FROM user_sessions WHERE user_id=ANY($1::uuid[])',
      [[id.worker,id.manager]]);
    await pool.query('DELETE FROM employees WHERE id=$1',[id.employee]);
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[id.worker,id.manager]]);
    await pool.query('DELETE FROM business_units WHERE id=$1',[id.unit]);
    await pool.query('DELETE FROM legal_entities WHERE id=$1',[id.entity]);
  }finally{await pool.end();}
});

test('employee cookie-blocked login succeeds via scoped bearer, revokes on logout and cannot access Admin',async()=>{
  const slug='safari-login-'+id.unit.slice(0,8);
  await pool.query(`INSERT INTO legal_entities(id,legal_name,display_name,slug)
    VALUES($1,'Safari Login Test','Safari Login Test',$2)`,[id.entity,slug]);
  await pool.query(`INSERT INTO business_units(id,legal_entity_id,name,slug)
    VALUES($1,$2,'Safari Login Test',$3)`,[id.unit,id.entity,slug+'-bu']);
  const pwHash=await hashPassword(password);
  await pool.query(`INSERT INTO users(id,email,display_name,password_hash)
    VALUES($1,$3,'Login Worker',$5),($2,$4,'Non Employee Manager',$5)`,
    [id.worker,id.manager,slug+'-worker@example.test',slug+'-manager@example.test',pwHash]);
  await pool.query(`INSERT INTO employees(id,business_unit_id,user_id,display_name,employee_number)
    VALUES($1,$2,$3,'Login Worker','SAFARI-LOGIN')`,[id.employee,id.unit,id.worker]);
  server=app.listen(0,'127.0.0.1');
  await new Promise<void>((resolve,reject)=>{
    if(server!.listening)return resolve();
    server!.once('listening',resolve);server!.once('error',reject);
  });
  const port=(server.address() as AddressInfo).port;
  const base='http://127.0.0.1:'+port;

  const logged=await call(base,'/api/employee/session/login',{
    method:'POST',headers:{origin,'content-type':'application/json'},
    body:JSON.stringify({email:slug+'-worker@example.test',password}),
  });
  assert.equal(logged.status,200);
  assert.equal(logged.headers.get('cache-control'),'no-store');
  const data=(await logged.json()).data;
  assert.match(data.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(data.profile.employment[0].businessUnitId,id.unit);
  assert.ok(Date.parse(data.expiresAt)>Date.now());
  assert.ok(Date.parse(data.expiresAt)<Date.now()+25*3600000);
  // Intentionally send no Cookie header. Safari blocks the cross-site cookie.
  const bearer={'Authorization':'Bearer '+data.token};
  const profile=await call(base,'/api/employee/me',{headers:{origin,...bearer}});
  assert.equal(profile.status,200);
  assert.equal((await profile.json()).data.employment[0].id,id.employee);
  assert.equal(profile.headers.get('cache-control'),'private, no-store');
  const jobs=await call(base,'/api/employee/jobs',{headers:{origin,...bearer}});
  assert.equal(jobs.status,200);
  const admin=await call(base,'/api/auth/me',{headers:{origin,...bearer}});
  assert.equal(admin.status,401,'Bearer credential must not be accepted by platform Admin');
  const badOrigin=await call(base,'/api/employee/me',
    {headers:{origin:'https://www.pioneerlegacyworks.com',...bearer}});
  assert.equal(badOrigin.status,403);
  const rejectedLogin=await call(base,'/api/employee/session/login',{
    method:'POST',headers:{origin:'https://www.pioneerlegacyworks.com',
      'content-type':'application/json'},
    body:JSON.stringify({email:slug+'-worker@example.test',password}),
  });
  assert.equal(rejectedLogin.status,403);
  const noEmployee=await call(base,'/api/employee/session/login',{
    method:'POST',headers:{origin,'content-type':'application/json'},
    body:JSON.stringify({email:slug+'-manager@example.test',password}),
  });
  assert.equal(noEmployee.status,403);
  const logout=await call(base,'/api/employee/session/logout',{
    method:'POST',headers:{origin,...bearer},
  });
  assert.equal(logout.status,204);
  assert.equal((await call(base,'/api/employee/me',{headers:{origin,...bearer}})).status,401);
  await assert.rejects(authenticateSessionToken(data.token),(e:unknown)=>
    typeof e==='object'&&e!==null&&'statusCode' in e&&e.statusCode===401);
});
