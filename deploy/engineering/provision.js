// An auth boundary: it issues Harper credentials. Its invariants are in DESIGN.md next to it.
import { randomBytes, randomUUID } from 'node:crypto';
import { Resource, databases, logger, server, transaction } from 'harper';
import { getLockScope } from '@harperfast/agent-memory';

const ASSIGNABLE_ROLES = Object.freeze(['eng', 'eng-public']);
const PROVISIONER_ROLE = 'provisioner';
export const MAX_DELEGATES = 16;
// A reservation younger than this belongs to a request still running; an older one with no user was interrupted.
export const RESERVATION_TTL_MS = 60_000;
// Bounds the rows one request reads for a principal's machine users, whatever an admin left in the table.
const DELEGATE_SCAN_LIMIT = 64;

// provision-user.sh's username rule.
const USERNAME = /^[A-Za-z0-9._@-]{1,122}$/;
// Lowercase only, so one person cannot become two users by case.
const PRINCIPAL = /^[a-z0-9._-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const MACHINE = /^[a-z0-9-]{1,32}$/;

const ACTION_FIELDS = {
	create: ['action', 'principal', 'role'],
	rotate: ['action', 'username'],
	addDelegate: ['action', 'principal', 'machine', 'role'],
};

export class ProvisionError extends Error {
	constructor(statusCode, code, message) {
		super(message);
		this.statusCode = statusCode;
		this.code = code;
	}
}

// Carries the step that failed, never the cause's text: an upstream error may hold credentials.
class StageFailure extends Error {
	constructor(stage, cause) {
		super(`provisioning failed at ${stage}`);
		this.stage = stage;
		this.causeName = cause?.name ?? 'Error';
		this.causeStatus = cause?.statusCode;
	}
}

const fail = (statusCode, code, message) => new ProvisionError(statusCode, code, message);
const userChanged = () => fail(409, 'user_changed', 'The user changed during the request; nothing was issued');
const time = (value) => new Date(value).getTime();

async function stage(name, fn) {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof ProvisionError || error instanceof StageFailure) throw error;
		throw new StageFailure(name, error);
	}
}

export function generatePassword() {
	return randomBytes(30).toString('base64url');
}

export function authorizeCaller(user) {
	if (typeof user?.username !== 'string') throw fail(401, 'authentication_required', 'Authentication required');
	if (user.role?.permission?.super_user === true || user.role?.role === PROVISIONER_ROLE) return user.username;
	throw fail(403, 'provisioner_required', 'Only the provisioner role may provision users');
}

function parsePrincipal(value) {
	if (typeof value !== 'string' || !USERNAME.test(value) || !PRINCIPAL.test(value)) {
		throw fail(400, 'invalid_principal', 'principal must be a lowercase email address of at most 122 characters');
	}
	return value;
}

function parseUsername(value) {
	if (typeof value !== 'string' || !USERNAME.test(value)) {
		throw fail(400, 'invalid_username', 'username must be 1-122 characters of A-Z, a-z, 0-9, ".", "_", "@" or "-"');
	}
	return value;
}

function parseMachine(value) {
	if (typeof value !== 'string' || !MACHINE.test(value)) {
		throw fail(400, 'invalid_machine', 'machine must be 1-32 characters of a-z, 0-9 or "-"');
	}
	return value;
}

function parseRole(value) {
	if (!ASSIGNABLE_ROLES.includes(value)) throw fail(403, 'role_not_assignable', 'role must be eng or eng-public');
	return value;
}

function delegateName(principal, machine) {
	const username = `${principal}.${machine}`;
	if (!USERNAME.test(username)) throw fail(400, 'invalid_machine', 'principal and machine exceed 122 characters');
	return username;
}

function parseBody(body) {
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		throw fail(400, 'invalid_body', 'Request body must be a JSON object');
	}
	if (typeof body.action !== 'string' || !Object.hasOwn(ACTION_FIELDS, body.action)) {
		throw fail(400, 'invalid_action', 'action must be create, rotate or addDelegate');
	}
	const allowed = ACTION_FIELDS[body.action];
	for (const key of Object.keys(body)) {
		if (!allowed.includes(key)) {
			throw fail(400, 'unknown_field', `${body.action} does not take ${JSON.stringify(key.slice(0, 64))}`);
		}
	}
	return body;
}

const assignable = (role) => (ASSIGNABLE_ROLES.includes(role) ? role : null);
const manageable = (user, record) => Boolean(record) && user.active && assignable(user.role) !== null;

// Grants on a leftover row would pass to a new user of that name, and an actsFor would make it act for someone. A
// delegate may reuse the row its own interrupted attempt wrote.
function grantRowReusable(row, actsFor) {
	if (!row) return true;
	if ((row.read?.length ?? 0) > 0 || (row.write?.length ?? 0) > 0) return false;
	return row.actsFor == null || row.actsFor === actsFor;
}

/**
 * The provisioning rules over a store, so tests can drive them with fakes. The store:
 * - `now()` → Date
 * - `getUser(username)` → `{ role, active }` or undefined (`role` is the role's name)
 * - `authenticate(username, password)` → `{ role, active }`, or undefined when the credentials are refused
 * - `addUser(username, password, role)`; rejects with a `user_exists` ProvisionError when the name is taken
 * - `setPassword(username, password)`
 * - `getRecord(username)`, `getGrantRow(username)` → the ProvisionedUser row, the ScopeGrant `user:` row, or undefined
 * - `delegatesOf(principal, limit)` → async iterable of the principal's ProvisionedUser rows (committed)
 * - `hasInboundDelegation(username)` → whether any ScopeGrant user row acts for `username`
 * - `withNameLock(usernames, fn)`: runs `fn(tx)` in one transaction holding each name's lock; `tx` has `getRecord`,
 *   `putRecord`, `deleteRecord`, `getGrantRow`, `putGrantRow` and `deleteGrantRow`
 */
function createProvisioning(store) {
	async function requireManaged(username) {
		const user = await store.getUser(username);
		if (!user) throw fail(404, 'user_not_found', 'No such user');
		const record = await store.getRecord(username);
		if (!record) {
			throw fail(403, 'not_managed', 'This user was not created by self-serve provisioning; an admin manages it');
		}
		if (!user.active) throw fail(403, 'user_inactive', 'This user is deactivated; an admin manages it');
		if (!assignable(user.role)) {
			throw fail(403, 'role_not_assignable', 'This user holds a role provisioning does not manage');
		}
		return { user, record };
	}

	// `actsFor` comes from the grant row rather than the record, so an admin's revocation shows.
	async function* liveDelegates(principal) {
		for await (const row of store.delegatesOf(principal, DELEGATE_SCAN_LIMIT)) {
			if (row.machine == null) continue;
			const user = await store.getUser(row.username);
			if (!user) continue;
			const grant = await store.getGrantRow(row.username);
			yield { username: row.username, role: assignable(user.role), actsFor: grant?.actsFor === principal };
		}
	}

	// An admin role change can leave a delegate acting for a principal of another role; nothing more is issued in
	// that group until an admin settles it (DESIGN.md).
	async function refuseMixedGroup(principal, principalRole) {
		for await (const delegate of liveDelegates(principal)) {
			if (delegate.actsFor && delegate.role !== principalRole) {
				throw fail(
					409,
					'mixed_delegation',
					'A machine user acts for a person of another role; an admin must settle it',
				);
			}
		}
	}

	// Machine users that exist, plus reservations still being created; read under the principal's lock.
	async function countMachines(principal, now) {
		let count = 0;
		for await (const row of store.delegatesOf(principal, DELEGATE_SCAN_LIMIT)) {
			if (row.machine == null) continue;
			if (now - time(row.createdAt) < RESERVATION_TTL_MS || (await store.getUser(row.username))) count++;
		}
		return count;
	}

	// `<principal>.<machine>` names a machine user, so no principal may read as one of an existing user.
	async function refuseDelegateShapedName(principal) {
		for (let dot = principal.indexOf('.', principal.indexOf('@')); dot !== -1; dot = principal.indexOf('.', dot + 1)) {
			const prefix = principal.slice(0, dot);
			if (PRINCIPAL.test(prefix) && (await store.getUser(prefix))) {
				throw fail(400, 'reserved_name', 'principal reads as a delegate of an existing user');
			}
		}
	}

	// A password is returned only while it authenticates the user it was meant for. One that does not is simply
	// dropped: nobody else ever held it, so no further write (which could clobber an admin's reset) is needed.
	async function confirmIssued(username, password, role) {
		const current = await stage('confirm', () => store.authenticate(username, password));
		const record = await store.getRecord(username);
		if (!current?.active || current.role !== role || !record) throw userChanged();
	}

	// Reserve, then create, so that every crash point leaves state the flow recovers (DESIGN.md). `owner` is the
	// principal a machine user is created under, re-checked under its lock.
	async function issue({ username, principal, machine, role, actsFor, owner }, caller) {
		const createdAt = store.now();
		let previousGrant;
		let tookOver = false;
		const names = machine === null ? [username] : [principal, username];
		await stage('reserve', () =>
			store.withNameLock(names, async (tx) => {
				if (await store.getUser(username)) throw fail(409, 'user_exists', 'User already exists');
				if (owner) {
					const current = await store.getUser(principal);
					if (!current?.active || current.role !== owner.role) throw userChanged();
					if ((await countMachines(principal, time(createdAt))) >= MAX_DELEGATES) {
						throw fail(409, 'too_many_delegates', `A person has at most ${MAX_DELEGATES} machine users`);
					}
				}
				const reservation = await tx.getRecord(username);
				if (reservation) {
					if (time(createdAt) - time(reservation.createdAt) < RESERVATION_TTL_MS) {
						throw fail(409, 'in_progress', 'Another request is creating this user; retry in a minute');
					}
					tookOver = true;
				}
				previousGrant = await tx.getGrantRow(username);
				if (!grantRowReusable(previousGrant, actsFor)) {
					throw fail(409, 'grant_row_exists', 'A ScopeGrant row for this name already exists; an admin must remove it');
				}
				if (machine === null && (await store.hasInboundDelegation(username))) {
					throw fail(409, 'inbound_delegation', 'Another user still acts for this name; an admin must remove that');
				}
				await tx.putRecord({ username, principal, machine, createdAt, createdBy: caller });
				if (actsFor) await tx.putGrantRow({ username, actsFor });
			}),
		);
		// Undoes this request's writes while they are still its own. After a takeover the record stays: the user that
		// exists is most likely the earlier request's, but the grant row is put back to what that request left.
		const release = () =>
			stage('release', () =>
				store.withNameLock([username], async (tx) => {
					const reservation = await tx.getRecord(username);
					if (!reservation || time(reservation.createdAt) !== time(createdAt)) return;
					if (!tookOver) await tx.deleteRecord(username);
					if (!actsFor) return;
					if (previousGrant) await tx.putGrantRow({ ...previousGrant, username });
					else await tx.deleteGrantRow(username);
				}),
			);
		const password = generatePassword();
		try {
			await stage('add_user', () => store.addUser(username, password, role));
		} catch (error) {
			const duplicate = error instanceof ProvisionError && error.code === 'user_exists';
			// An add_user that failed for another reason may still have created the user; keep the record if so.
			if (duplicate || !(await store.getUser(username))) await release();
			throw error;
		}
		if (owner && actsFor) {
			const current = await store.getUser(principal);
			if (!current?.active || current.role !== owner.role) {
				await stage('release', () => store.withNameLock([username], (tx) => tx.deleteGrantRow(username)));
				throw userChanged();
			}
		}
		await confirmIssued(username, password, role);
		return { username, password };
	}

	return {
		async describe(principalInput) {
			const principal = parsePrincipal(principalInput);
			const user = await store.getUser(principal);
			if (!user) return { exists: false, managed: false, role: null, delegates: [] };
			const record = await store.getRecord(principal);
			const delegates = [];
			for await (const delegate of liveDelegates(principal)) delegates.push(delegate);
			return { exists: true, managed: manageable(user, record), role: assignable(user.role), delegates };
		},

		async create(body, caller) {
			const principal = parsePrincipal(body.principal);
			const role = parseRole(body.role);
			await refuseDelegateShapedName(principal);
			return issue({ username: principal, principal, machine: null, role, actsFor: null }, caller);
		},

		async addDelegate(body, caller) {
			const principal = parsePrincipal(body.principal);
			const machine = parseMachine(body.machine);
			const role = parseRole(body.role);
			const username = delegateName(principal, machine);
			const owner = await requireManaged(principal);
			if (owner.record.machine != null) throw fail(400, 'not_a_principal', 'principal is itself a delegate');
			await refuseMixedGroup(principal, owner.user.role);
			// A delegate shares the principal's private scope, which is never content-checked, so only a delegate of
			// the principal's own role acts for it; any other is a standalone user (DESIGN.md).
			const actsFor = role === owner.user.role ? principal : null;
			const credentials = await issue({ username, principal, machine, role, actsFor, owner: owner.user }, caller);
			return { ...credentials, actsFor: actsFor !== null };
		},

		async rotate(body) {
			const username = parseUsername(body.username);
			const { user, record } = await requireManaged(username);
			const principal = record.machine == null ? username : record.principal;
			const principalRole = principal === username ? user.role : (await store.getUser(principal))?.role;
			await refuseMixedGroup(principal, principalRole);
			const password = generatePassword();
			await stage('set_password', () => store.setPassword(username, password));
			await confirmIssued(username, password, user.role);
			return { username, password };
		},
	};
}

function json(data, status = 200, extraHeaders) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...extraHeaders },
	});
}

const issued = (credentials, status) => json(credentials, status, { 'Cache-Control': 'no-store' });

function principalFromPath(target) {
	const path = String(target?.pathname ?? '').replace(/^\//, '');
	try {
		return decodeURIComponent(path);
	} catch {
		throw fail(400, 'invalid_principal', 'The path is not valid percent-encoding');
	}
}

async function readBody(data) {
	try {
		return await data;
	} catch {
		throw fail(400, 'invalid_body', 'Request body must be valid JSON');
	}
}

function errorResponse(error, method) {
	if (error instanceof ProvisionError) return json({ error: error.message, code: error.code }, error.statusCode);
	const ref = randomUUID().slice(0, 8);
	const failure = error instanceof StageFailure ? error : new StageFailure('request', error);
	logger.error?.(
		`[provision] ${method} failed at ${failure.stage} (ref ${ref}): ${failure.causeName} status ${failure.causeStatus ?? '-'}`,
	);
	if (failure.causeStatus === 423 || failure.causeStatus === 503) {
		return json({ error: 'Temporarily unavailable; retry shortly', code: 'unavailable', ref }, 503);
	}
	return json({ error: 'Internal error', code: 'internal_error', ref }, 500);
}

/**
 * One request to `/Provision/`. `user` is the authenticated Harper user, or undefined; `openStore()` returns the
 * store, opened only once the caller is the provisioner.
 */
export async function handleProvisionRequest(method, target, data, user, openStore) {
	// A body nobody reads must not become an unhandled rejection.
	data?.catch?.(() => {});
	try {
		const caller = authorizeCaller(user);
		const path = principalFromPath(target);
		const provisioning = createProvisioning(openStore());
		if (method === 'GET') return json(await provisioning.describe(path));
		if (method !== 'POST') throw fail(405, 'method_not_allowed', 'Method not allowed');
		if (path !== '') throw fail(404, 'not_found', 'POST to /Provision/');
		const body = parseBody(await readBody(data));
		switch (body.action) {
			case 'create':
				return issued(await provisioning.create(body, caller), 201);
			case 'addDelegate':
				return issued(await provisioning.addDelegate(body, caller), 201);
			default:
				return issued(await provisioning.rotate(body), 200);
		}
	} catch (error) {
		return errorResponse(error, method);
	}
}

function harperStore(user) {
	const system = databases.system;
	const { ProvisionedUser, ScopeGrant } = databases.memory;
	const read = { authorize: false };
	const operation = (body) => server.operation(body, { user }, false);
	const grantId = (username) => `user:${username}`;
	return {
		now: () => new Date(),
		async getUser(username) {
			const record = await system.hdb_user.get(username, read);
			if (!record) return undefined;
			const role = record.role == null ? null : await system.hdb_role.get(record.role, read);
			return { role: typeof role?.role === 'string' ? role.role : null, active: record.active === true };
		},
		async authenticate(username, password) {
			let authenticated;
			try {
				authenticated = await server.authenticateUser(username, password);
			} catch (error) {
				// Harper refuses a wrong password or an inactive user with 401; anything else is a fault.
				if (error?.statusCode === 401) return undefined;
				throw error;
			}
			if (!authenticated) return undefined;
			return { role: authenticated.role?.role ?? null, active: authenticated.active === true };
		},
		async addUser(username, password, role) {
			try {
				await operation({ operation: 'add_user', username, password, role, active: true });
			} catch (error) {
				if (error?.statusCode === 409) throw fail(409, 'user_exists', 'User already exists');
				throw error;
			}
		},
		async setPassword(username, password) {
			await operation({ operation: 'alter_user', username, password });
		},
		async getRecord(username) {
			return (await ProvisionedUser.get(username, read)) ?? undefined;
		},
		async getGrantRow(username) {
			return (await ScopeGrant.get(grantId(username), read)) ?? undefined;
		},
		delegatesOf(principal, limit) {
			return ProvisionedUser.search({ conditions: [{ attribute: 'principal', value: principal }], limit }, read);
		},
		async hasInboundDelegation(username) {
			// actsFor is not indexed; the table holds one row per role and per user with grants.
			const rows = ScopeGrant.search(
				{ conditions: [{ attribute: 'id', comparator: 'starts_with', value: 'user:' }], select: ['actsFor'] },
				read,
			);
			for await (const row of rows) if (row.actsFor === username) return true;
			return false;
		},
		withNameLock(usernames, fn) {
			const context = { user };
			return transaction(context, async () => {
				// One order for every request, so two locking the same names cannot deadlock.
				for (const name of [...usernames].sort()) {
					await ProvisionedUser.lock(name, { scope: getLockScope() ?? 'node' }, context);
				}
				return fn({
					getRecord: async (id) => (await ProvisionedUser.get(id, context)) ?? undefined,
					putRecord: (record) => ProvisionedUser.put(record, context),
					deleteRecord: (id) => ProvisionedUser.delete(id, context),
					getGrantRow: async (id) => (await ScopeGrant.get(grantId(id), context)) ?? undefined,
					putGrantRow: ({ username: id, ...row }) => ScopeGrant.put({ ...row, id: grantId(id) }, context),
					deleteGrantRow: (id) => ScopeGrant.delete(grantId(id), context),
				});
			});
		},
	};
}

export class Provision extends Resource {
	static hidden = true;

	// Harper leaves a GET, DELETE or stream request's body on `context.data`.
	static get(target, context) {
		return handleProvisionRequest('GET', target, context?.data, context?.user, () => harperStore(context?.user));
	}

	static post(target, data, context) {
		return handleProvisionRequest('POST', target, data, context?.user, () => harperStore(context?.user));
	}

	static put(target, data, context) {
		return handleProvisionRequest('PUT', target, data, context?.user, () => harperStore(context?.user));
	}

	static patch(target, data, context) {
		return handleProvisionRequest('PATCH', target, data, context?.user, () => harperStore(context?.user));
	}

	static delete(target, context) {
		return handleProvisionRequest('DELETE', target, context?.data, context?.user, () => harperStore(context?.user));
	}

	static async subscribe(_target, context) {
		authorizeCaller(context?.user);
		throw fail(405, 'method_not_allowed', 'Method not allowed');
	}

	static async connect(target, incomingMessages, context) {
		if (incomingMessages == null) {
			return handleProvisionRequest('CONNECT', target, context?.data, context?.user, () => harperStore(context?.user));
		}
		return this.subscribe(target, context);
	}
}
