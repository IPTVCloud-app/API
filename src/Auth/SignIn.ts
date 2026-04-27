import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import bcrypt from 'bcryptjs';
import { supabase } from '../Database/DB.js';
import { sendVerificationEmail } from '../EmailManager.js';

const router = new Hono();

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-dev-only';

const signinInitSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const signinVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

const createOrUpdateOtp = async (email: string, type: 'login' | 'reset' | 'verify_email' | 'change_username') => {
  const { data: existing } = await supabase
    .from('auth_codes')
    .select('expires_at')
    .eq('email', email)
    .eq('type', type)
    .single();

  if (existing) {
    const expiresAt = new Date(existing.expires_at).getTime();
    const createdAt = expiresAt - (30 * 60 * 1000); 
    const now = Date.now();
    const diff = Math.floor((now - createdAt) / 1000);
    
    if (diff < 60) {
      throw new Error(`Please wait ${60 - diff} seconds before requesting a new code`);
    }
  }

  const code = generateOtp();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const { error } = await supabase
    .from('auth_codes')
    .upsert({ email, code, expires_at: expiresAt, type }, { onConflict: 'email,type' });

  if (error) {
    throw new Error('Failed to generate verification code');
  }

  return code;
};

/**
 * Step 1: Initialize Sign-in (Credentials + OTP Send)
 */
router.post('/init', zValidator('json', signinInitSchema), async (c) => {
  const { email, password } = c.req.valid('json');

  try {
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (fetchError || !user) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    const code = await createOrUpdateOtp(email, 'login');
    await sendVerificationEmail(email, code);

    return c.json({ message: 'Verification code sent' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

/**
 * Step 2: Verify OTP & Issue JWT
 */
router.post('/verify', zValidator('json', signinVerifySchema), async (c) => {
  const { email, code } = c.req.valid('json');

  try {
    const { data: otpData, error: otpError } = await supabase
      .from('auth_codes')
      .select('*')
      .eq('email', email)
      .eq('code', code)
      .eq('type', 'login')
      .gt('expires_at', new Date().toISOString())
      .single();

    if (otpError || !otpData) {
      return c.json({ error: 'Invalid or expired verification code' }, 400);
    }

    const { data: user } = await supabase
      .from('users')
      .select('id, email, username')
      .eq('email', email)
      .single();

    if (!user) {
      return c.json({ error: 'User not found' }, 404);
    }

    const token = await sign({ 
      id: user.id, 
      email: user.email,
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7) 
    }, JWT_SECRET);

    await supabase.from('auth_codes').delete().eq('email', email).eq('type', 'login');

    return c.json({ 
      message: 'Login successful',
      token,
      user: { id: user.id, email: user.email, username: user.username }
    }, 200);
  } catch {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
export { createOrUpdateOtp }; // Exported for other auth modules if needed
