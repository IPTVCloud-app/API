import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import bcrypt from 'bcryptjs';
import { supabase } from '../db/client.js';
import { sendVerificationEmail, sendPasswordResetEmail } from '../lib/email.js';

const auth = new Hono();

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-dev-only';

// --- Schemas ---

const signupSchema = z.object({
  firstName: z.string().min(1),
  middleInitial: z.string().max(1).optional(),
  lastName: z.string().optional(),
  suffix: z.string().optional(),
  username: z.string().min(3),
  email: z.string().email(),
  password: z.string().min(8),
});

const signinInitSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const signinVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

const resendOtpSchema = z.object({
  email: z.string().email(),
});

const findAccountSchema = z.object({
  username: z.string().min(3),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

// --- Helper Functions ---

const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

const createOrUpdateOtp = async (email: string, type: 'login' | 'reset') => {
  const code = generateOtp();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes

  const { error } = await supabase
    .from('auth_codes')
    .upsert({ email, code, expires_at: expiresAt, type }, { onConflict: 'email,type' });

  if (error) {
    console.error('OTP store error:', error);
    throw new Error('Failed to generate verification code');
  }

  return code;
};

// --- Routes ---

/**
 * Signup Route
 */
auth.post('/signup', zValidator('json', signupSchema), async (c) => {
  const data = c.req.valid('json');

  try {
    // 1. Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .or(`email.eq.${data.email},username.eq.${data.username}`)
      .single();

    if (existingUser) {
      return c.json({ error: 'Email or Username already taken' }, 400);
    }

    // 2. Hash the password
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(data.password, salt);

    // 3. Create user
    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert([{ 
        email: data.email, 
        password_hash: hashedPassword, 
        username: data.username,
        first_name: data.firstName,
        middle_initial: data.middleInitial,
        last_name: data.lastName,
        suffix: data.suffix,
        created_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (createError) {
      console.error('Signup error:', createError);
      return c.json({ error: 'Failed to create account' }, 500);
    }

    return c.json({ message: 'Account created successfully. Please sign in.' }, 201);
  } catch (error) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * Signin Init Route (Credentials check + Send OTP)
 */
auth.post('/signin/init', zValidator('json', signinInitSchema), async (c) => {
  const { email, password } = c.req.valid('json');

  try {
    // 1. Fetch user
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('*')
      .eq('email', email)
      .single();

    if (fetchError || !user) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    // 2. Compare passwords
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return c.json({ error: 'Invalid email or password' }, 401);
    }

    // 3. Generate and send OTP
    const code = await createOrUpdateOtp(email, 'login');
    await sendVerificationEmail(email, code);

    return c.json({ message: 'Verification code sent' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

/**
 * Signin Verify Route (Validate OTP + Issue Token)
 */
auth.post('/signin/verify', zValidator('json', signinVerifySchema), async (c) => {
  const { email, code } = c.req.valid('json');

  try {
    // 1. Check OTP
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

    // 2. Fetch user to get ID for token
    const { data: user } = await supabase
      .from('users')
      .select('id, email, username')
      .eq('email', email)
      .single();

    // 3. Generate JWT
    const token = await sign({ 
      id: user.id, 
      email: user.email,
      exp: Math.floor(Date.now() / 1000) + (60 * 60 * 24 * 7) // 1 week
    }, JWT_SECRET);

    // 4. Clean up OTP
    await supabase.from('auth_codes').delete().eq('email', email).eq('type', 'login');

    return c.json({ 
      message: 'Login successful',
      token,
      user: { id: user.id, email: user.email, username: user.username }
    }, 200);
  } catch (error) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * Resend OTP
 */
auth.post('/otp/resend', zValidator('json', resendOtpSchema), async (c) => {
  const { email } = c.req.valid('json');
  try {
    const code = await createOrUpdateOtp(email, 'login');
    await sendVerificationEmail(email, code);
    return c.json({ message: 'Code resent' }, 200);
  } catch (error: any) {
    return c.json({ error: error.message || 'Internal server error' }, 500);
  }
});

/**
 * Find Account Route (Search by Username)
 */
auth.post('/find-account', zValidator('json', findAccountSchema), async (c) => {
  const { username } = c.req.valid('json');
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('email')
      .eq('username', username)
      .single();

    if (error || !user) {
      return c.json({ error: 'Account not found' }, 404);
    }

    // Mask email for privacy (e.g., j***e@gmail.com)
    const [local, domain] = user.email.split('@');
    const maskedLocal = local.length > 2 ? local[0] + '*'.repeat(local.length - 2) + local[local.length - 1] : local[0] + '*';
    const maskedEmail = `${maskedLocal}@${domain}`;

    return c.json({ email: user.email, maskedEmail }, 200);
  } catch (error) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

/**
 * Forgot Password Route
 */
auth.post('/password/forgot', zValidator('json', forgotPasswordSchema), async (c) => {
  const { email } = c.req.valid('json');
  try {
    // 1. Verify email exists
    const { data: user } = await supabase.from('users').select('id').eq('email', email).single();
    if (!user) {
      // Return success anyway for privacy
      return c.json({ message: 'If an account exists, a reset link has been sent' }, 200);
    }

    // 2. Generate reset token/code
    const code = await createOrUpdateOtp(email, 'reset');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetLink = `${frontendUrl}/account/reset-password?email=${encodeURIComponent(email)}&token=${code}`;

    // 3. Send email
    await sendPasswordResetEmail(email, resetLink);

    return c.json({ message: 'Reset link sent successfully' }, 200);
  } catch (error) {
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default auth;
