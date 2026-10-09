import { pool } from '../../db/pool.js';
import { HttpError } from '../../lib/http-error.js';
import { assertBusinessUnitPermission } from '../access/authorization.service.js';
import { writeAuditEvent } from '../audit/admin-audit.service.js';
import { requestPasswordReset } from '../auth/password-management.service.js';

type RequestMetadata = { ipAddress: string | null; userAgent: string | null };
type EmployeeAccountRow = {
  id: string;
  user_id: string | null;
  email: string | null;
  display_name: string;
  status: string;
};

async function assertCanManageAccounts(actorUserId: string, businessUnitId: string) {
  await assertBusinessUnitPermission(actorUserId, businessUnitId, 'employees.write');
  await assertBusinessUnitPermission(actorUserId, businessUnitId, 'employee_accounts.manage');
}

async function loadEmployee(businessUnitId: string, employeeId: string) {
  const result = await pool.query<EmployeeAccountRow>(
    'SELECT id, user_id, email::text, display_name, status FROM employees WHERE id = $1 AND business_unit_id = $2',
    [employeeId, businessUnitId]
  );
  const employee = result.rows[0];
  if (!employee) throw new HttpError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found in this business.');
  return employee;
}

async function getEmployeeLoginEmail(businessUnitId: string, employeeId: string) {
  const employee = await loadEmployee(businessUnitId, employeeId);
  if (!employee.user_id) {
    throw new HttpError(409, 'EMPLOYEE_ACCOUNT_MISSING', 'Create the employee login account first.');
  }
  const result = await pool.query<{ email: string }>(
    `SELECT u.email::text AS email
     FROM users u
     JOIN user_role_assignments ura ON ura.user_id = u.id
     JOIN roles r ON r.id = ura.role_id
     WHERE u.id = $1 AND u.status = 'active'
       AND r.key = 'employee' AND r.scope = 'business_unit'
       AND ura.business_unit_id = $2`,
    [employee.user_id, businessUnitId]
  );
  if (!result.rows[0]) {
    throw new HttpError(403, 'EMPLOYEE_ACCOUNT_ROLE_MISMATCH',
      'This employee is not linked to an active employee-scoped login.');
  }
  return { employee, email: result.rows[0].email };
}

export async function inviteEmployeeAccount(
  actorUserId: string,
  businessUnitId: string,
  employeeId: string,
  metadata: RequestMetadata
) {
  await assertCanManageAccounts(actorUserId, businessUnitId);
  const employee = await loadEmployee(businessUnitId, employeeId);
  if (employee.status !== 'active') {
    throw new HttpError(409, 'EMPLOYEE_INACTIVE', 'Only active employees can receive login invitations.');
  }
  if (!employee.email) {
    throw new HttpError(400, 'EMPLOYEE_EMAIL_REQUIRED', 'Add an employee email before issuing an invitation.');
  }

  // Existing employee-only accounts can receive a new single-use reset link.
  if (employee.user_id) {
    const linked = await getEmployeeLoginEmail(businessUnitId, employeeId);
    await requestPasswordReset(linked.email, metadata);
    await writeAuditEvent({ actorUserId, businessUnitId, action: 'employee.invitation.resent',
      resourceType: 'employee', resourceId: employeeId, ipAddress: metadata.ipAddress, userAgent: metadata.userAgent });
    return { accepted: true, userId: employee.user_id };
  }

  const client = await pool.connect();
  let newUserId: string;
  try {
    await client.query('BEGIN');
    const locked = await client.query<EmployeeAccountRow>(
      'SELECT id, user_id, email::text, display_name, status FROM employees WHERE id=$1 AND business_unit_id=$2 FOR UPDATE',
      [employeeId, businessUnitId]
    );
    const current = locked.rows[0];
    if (!current || current.status !== 'active' || current.user_id || !current.email) {
      throw new HttpError(409, 'EMPLOYEE_CHANGED', 'Employee account data changed. Refresh and retry.');
    }
    const role = await client.query<{ id: string }>(
      "SELECT id FROM roles WHERE key='employee' AND scope='business_unit'"
    );
    if (!role.rows[0]) throw new HttpError(503, 'EMPLOYEE_ROLE_MISSING', 'Employee identity migration has not been applied.');
    const created = await client.query<{ id: string }>(
      "INSERT INTO users (email, display_name, status, password_hash) VALUES ($1, $2, 'active', NULL) RETURNING id",
      [current.email, current.display_name]
    );
    newUserId = created.rows[0]!.id;
    await client.query(
      'INSERT INTO user_role_assignments (user_id, role_id, business_unit_id, assigned_by_user_id) VALUES ($1,$2,$3,$4)',
      [newUserId, role.rows[0].id, businessUnitId, actorUserId]
    );
    await client.query('UPDATE employees SET user_id=$1 WHERE id=$2 AND business_unit_id=$3',
      [newUserId, employeeId, businessUnitId]);
    await client.query(
      `INSERT INTO audit_log (actor_user_id, business_unit_id, action, resource_type, resource_id, metadata, ip_address, user_agent)
       VALUES ($1, $2, 'employee.account.created', 'employee', $3, $4::jsonb, $5, $6)`,
      [actorUserId, businessUnitId, employeeId, JSON.stringify({ userId: newUserId }), metadata.ipAddress, metadata.userAgent?.slice(0, 1000) ?? null]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new HttpError(409, 'ACCOUNT_EMAIL_EXISTS',
        'This email already has an account. Link an appropriate existing user instead.');
    }
    throw error;
  } finally {
    client.release();
  }

  // Uses the established password-reset outbox and a single-use 30-minute token.
  await requestPasswordReset(employee.email, metadata);
  return { accepted: true, userId: newUserId! };
}

export async function resetEmployeePassword(
  actorUserId: string, businessUnitId: string, employeeId: string, metadata: RequestMetadata
) {
  await assertCanManageAccounts(actorUserId, businessUnitId);
  const { employee, email } = await getEmployeeLoginEmail(businessUnitId, employeeId);
  await requestPasswordReset(email, metadata);
  await writeAuditEvent({ actorUserId, businessUnitId, action: 'employee.password_reset.requested',
    resourceType: 'employee', resourceId: employee.id, ipAddress: metadata.ipAddress, userAgent: metadata.userAgent });
  return { accepted: true };
}
