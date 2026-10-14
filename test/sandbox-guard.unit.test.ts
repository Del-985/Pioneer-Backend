import test from 'node:test';
import assert from 'node:assert/strict';
import {sandboxConfigurationErrors} from '../src/config/sandbox-guard.js';
const valid={APP_ENV:'sandbox',DATABASE_URL:'postgres://sandbox:fake@localhost/pioneer_payroll_sandbox',SESSION_COOKIE_NAME:'pioneer_sandbox_session'};
test('sandbox refuses production database, shared cookies and external credentials',()=>{
 assert.deepEqual(sandboxConfigurationErrors(valid),[]);
 assert.ok(sandboxConfigurationErrors({...valid,DATABASE_URL:'postgres://localhost/pioneer'}).length);
 for(const key of ['SMTP_HOST','TEXTBEE_API_KEY','OBJECT_STORAGE_ACCESS_KEY_ID','SESSION_COOKIE_DOMAIN'])assert.ok(sandboxConfigurationErrors({...valid,[key]:'configured'}).length);
 assert.ok(sandboxConfigurationErrors({...valid,SESSION_COOKIE_NAME:'pioneer_session'}).length);
 assert.deepEqual(sandboxConfigurationErrors({APP_ENV:'production'}),[]);
});
