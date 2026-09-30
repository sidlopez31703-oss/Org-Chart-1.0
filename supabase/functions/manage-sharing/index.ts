import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function respond(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return respond(405, { error: 'POST required.' });

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const appOrigin = Deno.env.get('APP_ORIGIN');
  const allowedEmailDomain = Deno.env.get('ALLOWED_EMAIL_DOMAIN')?.trim().toLowerCase();
  if (!url || !anonKey || !serviceKey || !appOrigin) {
    return respond(500, { error: 'Server configuration is incomplete.' });
  }

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return respond(401, { error: 'Sign in is required.' });
  const token = authorization.slice('Bearer '.length);
  const authClient = createClient(url, anonKey, { global: { headers: { Authorization: authorization } } });
  const { data: authData, error: authError } = await authClient.auth.getUser(token);
  if (authError || !authData.user) return respond(401, { error: 'Your sign-in has expired.' });

  const service = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data: caller, error: callerError } = await service
    .from('org_members')
    .select('role')
    .eq('user_id', authData.user.id)
    .maybeSingle();
  if (callerError || caller?.role !== 'admin') return respond(403, { error: 'Only an administrator can manage sharing.' });

  let payload: { action?: string; email?: string; role?: string };
  try {
    payload = await request.json();
  } catch {
    return respond(400, { error: 'Invalid request body.' });
  }

  if (payload.action === 'list') {
    const { data, error } = await service
      .from('org_members')
      .select('user_id,email,role,created_at')
      .order('created_at');
    return error ? respond(500, { error: 'Could not load shared access.' }) : respond(200, { members: data });
  }

  const email = String(payload.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return respond(400, { error: 'Enter a valid email address.' });
  if (payload.action === 'invite') {
    if (allowedEmailDomain && !email.endsWith(`@${allowedEmailDomain}`)) {
      return respond(403, { error: `Only ${allowedEmailDomain} email addresses can be shared into this directory.` });
    }
    const role = payload.role === 'admin' ? 'admin' : 'viewer';
    if (role === 'admin') {
      const { count, error } = await service.from('org_members').select('*', { count: 'exact', head: true }).eq('role', 'admin');
      if (error) return respond(500, { error: 'Could not verify administrator capacity.' });
      const { data: existing } = await service.from('org_members').select('role').eq('email', email).maybeSingle();
      if (existing?.role !== 'admin' && (count || 0) >= 2) return respond(409, { error: 'The two administrator positions are already filled.' });
    }

    let invitedUser: { id: string; email?: string | null } | null = null;
    const { data: invited, error: inviteError } = await service.auth.admin.inviteUserByEmail(email, {
      redirectTo: appOrigin,
    });
    if (inviteError) {
      const message = inviteError.message.toLowerCase();
      if (!message.includes('already') && !message.includes('exists') && !message.includes('registered')) {
        return respond(400, { error: inviteError.message });
      }
      for (let page = 1; page <= 10 && !invitedUser; page += 1) {
        const { data: users, error } = await service.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) return respond(500, { error: 'Could not find the existing invited account.' });
        invitedUser = users.users.find((user) => user.email?.toLowerCase() === email) || null;
        if (users.users.length < 1000) break;
      }
    } else {
      invitedUser = invited.user;
    }
    if (!invitedUser) return respond(500, { error: 'The invitation was created without a user record.' });

    const { error: memberError } = await service.from('org_members').upsert({
      user_id: invitedUser.id,
      email,
      role,
      invited_by: authData.user.id,
    }, { onConflict: 'user_id' });
    if (memberError) {
      if (memberError.message.includes('maximum of two')) return respond(409, { error: 'The two administrator positions are already filled.' });
      return respond(500, { error: 'The invitation could not be assigned directory access.' });
    }
    return respond(200, { message: 'Access granted.', role, invitationSent: !inviteError });
  }

  if (payload.action === 'set-role') {
    const role = payload.role === 'admin' ? 'admin' : 'viewer';
    const { data: target, error: targetError } = await service.from('org_members').select('user_id,role').eq('email', email).maybeSingle();
    if (targetError || !target) return respond(404, { error: 'That person is not on the sharing list.' });
    if (target.role === 'admin' && role !== 'admin') {
      const { count, error } = await service.from('org_members').select('*', { count: 'exact', head: true }).eq('role', 'admin');
      if (error || (count || 0) <= 1) return respond(409, { error: 'At least one administrator must remain.' });
    }
    const { error } = await service.from('org_members').update({ role }).eq('user_id', target.user_id);
    if (error) return respond(error.message.includes('maximum of two') ? 409 : 500, { error: error.message });
    return respond(200, { message: 'Access role updated.' });
  }

  if (payload.action === 'remove') {
    const { data: target, error: targetError } = await service.from('org_members').select('user_id,role').eq('email', email).maybeSingle();
    if (targetError || !target) return respond(404, { error: 'That person is not on the sharing list.' });
    if (target.user_id === authData.user.id) return respond(400, { error: 'You cannot remove your own access.' });
    if (target.role === 'admin') {
      const { count, error } = await service.from('org_members').select('*', { count: 'exact', head: true }).eq('role', 'admin');
      if (error || (count || 0) <= 1) return respond(409, { error: 'At least one administrator must remain.' });
    }
    const { error } = await service.from('org_members').delete().eq('user_id', target.user_id);
    return error ? respond(500, { error: 'Could not remove access.' }) : respond(200, { message: 'Access removed.' });
  }

  return respond(400, { error: 'Unsupported sharing action.' });
});
