export function sandboxConfigurationErrors(value:Record<string,unknown>):string[]{
 if(value.APP_ENV!=='sandbox')return [];
 const errors:string[]=[];
 try{if(decodeURIComponent(new URL(String(value.DATABASE_URL)).pathname)!=='/pioneer_payroll_sandbox')errors.push('Sandbox requires its own pioneer_payroll_sandbox database');}catch{errors.push('Sandbox database URL is invalid');}
 for(const key of ['SMTP_HOST','SMTP_USER','SMTP_PASSWORD','TEXTBEE_API_KEY','OBJECT_STORAGE_ACCESS_KEY_ID','OBJECT_STORAGE_SECRET_ACCESS_KEY','SESSION_COOKIE_DOMAIN'])if(value[key])errors.push(key+' must be unset in the sandbox');
 if(value.SESSION_COOKIE_NAME!=='pioneer_sandbox_session')errors.push('Sandbox requires a separate session cookie');
 return errors;
}
