import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS, // App Password
  },
});

const getEmailTemplate = (title: string, content: string) => `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta color-scheme="light dark">
<style>
  :root {
    --bg-page: #f7f8f8;
    --bg-surface: #ffffff;
    --text-primary: #1a1a1e;
    --text-secondary: #3c3c43;
    --text-tertiary: #62666d;
    --text-quaternary: #8a8f98;
    --brand: #5e6ad2;
    --accent: #7170ff;
    --border-subtle: #e6e6e6;
    --border-primary: #d0d6e0;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg-page: #08090a;
      --bg-surface: #0f1011;
      --text-primary: #f7f8f8;
      --text-secondary: #d0d6e0;
      --text-tertiary: #8a8f98;
      --text-quaternary: #62666d;
      --brand: #5e6ad2;
      --accent: #7170ff;
      --border-subtle: rgba(255, 255, 255, 0.05);
      --border-primary: #23252a;
    }
  }

  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }

  body {
    background-color: var(--bg-page);
    color: var(--text-primary);
    font-family: 'Inter', -apple-system, system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 16px;
    line-height: 1.5;
    font-feature-settings: "cv01" 1, "ss03" 1;
    -webkit-font-smoothing: antialiased;
  }

  .container {
    max-width: 600px;
    margin: 40px auto;
    padding: 32px;
    background-color: var(--bg-surface);
    border: 1px solid var(--border-primary);
    border-radius: 12px;
    box-shadow: rgba(0, 0, 0, 0.08) 0px 0px 0px 1px, rgba(0, 0, 0, 0.04) 0px 2px 4px 0px;
  }

  .header {
    margin-bottom: 32px;
    padding-bottom: 24px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .logo {
    font-size: 16px;
    font-weight: 510;
    letter-spacing: -0.28px;
    color: var(--text-primary);
    text-decoration: none;
  }

  h2 {
    margin-top: 0;
    font-size: 24px;
    font-weight: 400;
    line-height: 1.33;
    letter-spacing: -0.288px;
    color: var(--text-primary);
    margin-bottom: 16px;
  }

  p {
    font-size: 15px;
    line-height: 1.6;
    color: var(--text-tertiary);
    margin-bottom: 20px;
    letter-spacing: -0.165px;
  }

  p:last-of-type {
    margin-bottom: 0;
  }

  .content-section {
    margin: 24px 0;
  }

  .code-box {
    background-color: var(--bg-page);
    color: var(--text-primary);
    font-size: 36px;
    font-weight: 700;
    font-family: 'Berkeley Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    text-align: center;
    padding: 24px;
    border-radius: 8px;
    letter-spacing: 8px;
    margin: 32px 0;
    border: 1px solid var(--border-subtle);
  }

  .btn {
    display: inline-block;
    background-color: var(--brand);
    color: #ffffff;
    padding: 12px 24px;
    border-radius: 6px;
    text-decoration: none;
    font-weight: 510;
    font-size: 14px;
    margin: 16px 0;
    transition: background-color 0.15s;
  }

  .btn:hover {
    background-color: var(--accent);
  }

  .footer {
    margin-top: 32px;
    padding-top: 24px;
    border-top: 1px solid var(--border-subtle);
    font-size: 12px;
    color: var(--text-quaternary);
    text-align: center;
    line-height: 1.6;
  }

  .link-raw {
    color: var(--brand);
    font-size: 12px;
    word-break: break-all;
    font-family: 'Berkeley Mono', ui-monospace, 'SF Mono', Menlo, monospace;
    margin: 12px 0;
  }

  .emphasis {
    color: var(--text-secondary);
    font-weight: 510;
  }

  .meta-text {
    font-size: 13px;
    color: var(--text-quaternary);
    margin-top: 8px;
  }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">IPTVCloud</div>
    </div>
    <h2>${title}</h2>
    ${content}
    <div class="footer">
      © 2026 IPTVCloud.app. All rights reserved.<br>
      This is an automated message, please do not reply.
    </div>
  </div>
</body>
</html>
`;

export const sendVerificationEmail = async (email: string, code: string) => {
  const content = `
    <div class="content-section">
      <p>Your verification code is:</p>
      <div class="code-box">${code}</div>
      <p class="meta-text">This code will expire in <span class="emphasis">30 minutes</span>. If you didn't request this verification, you can safely ignore this email.</p>
    </div>
  `;

  const mailOptions = {
    from: `"IPTVCloud Support" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Verify your Identity - IPTVCloud',
    html: getEmailTemplate('Verify your Identity', content),
  };

  return transporter.sendMail(mailOptions);
};

export const sendPasswordResetEmail = async (email: string, link: string) => {
  const content = `
    <div class="content-section">
      <p>We received a request to reset your password. Click the button below to set a new password:</p>
      <div style="text-align: center;">
        <a href="${link}" class="btn">Reset Password</a>
      </div>
      <p style="margin-top: 24px;">If the button doesn't work, copy and paste this link into your browser:</p>
      <p class="link-raw">${link}</p>
      <p class="meta-text">This link will expire in <span class="emphasis">24 hours</span>.</p>
    </div>
  `;

  const mailOptions = {
    from: `"IPTVCloud Support" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Reset your Password - IPTVCloud',
    html: getEmailTemplate('Reset your Password', content),
  };

  return transporter.sendMail(mailOptions);
};

export const sendWelcomeEmail = async (email: string, userName: string) => {
  const content = `
    <div class="content-section">
      <p>Welcome to <span class="emphasis">IPTVCloud</span>, ${userName}!</p>
      <p>We're excited to have you on board. Your account has been successfully created and is ready to use.</p>
      <p style="margin-top: 24px;">Get started by exploring our channels and creating your favorite playlists. If you have any questions, feel free to reach out to our support team.</p>
    </div>
  `;

  const mailOptions = {
    from: `"IPTVCloud Support" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Welcome to IPTVCloud',
    html: getEmailTemplate('Welcome to IPTVCloud', content),
  };

  return transporter.sendMail(mailOptions);
};

export const sendAccountWarningEmail = async (email: string, reason: string) => {
  const content = `
    <div class="content-section">
      <p>We detected unusual activity on your account:</p>
      <p style="margin: 16px 0; padding: 12px; background-color: var(--bg-page); border-left: 3px solid var(--brand); border-radius: 4px;">
        <span class="emphasis">${reason}</span>
      </p>
      <p>If this wasn't you, please secure your account immediately by resetting your password. Contact our support team if you need assistance.</p>
    </div>
  `;

  const mailOptions = {
    from: `"IPTVCloud Support" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Account Security Alert - IPTVCloud',
    html: getEmailTemplate('Account Security Alert', content),
  };

  return transporter.sendMail(mailOptions);
};
