'use strict';

/**
 * WorkshopOne Email Configuration Verification Utility
 *
 * Usage:
 *   node scripts/test_email.js [optional_recipient_email]
 *
 * Example:
 *   node scripts/test_email.js myemail@gmail.com
 */

const path = require('path');
const config = require('../src/config'); // Automatically loads .env

async function main() {
  console.log('=== WorkshopOne Email Configuration Diagnostic ===\n');

  const smtpService = process.env.SMTP_SERVICE;
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '587', 10);
  const smtpSecure = process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true' || smtpPort === 465;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || (smtpUser ? `"WorkshopOne" <${smtpUser}>` : null);

  console.log('Current Settings in .env:');
  console.log('  SMTP_SERVICE :', smtpService || '(not set)');
  console.log('  SMTP_HOST    :', smtpHost || (smtpService ? `(preset for ${smtpService})` : '(not set)'));
  console.log('  SMTP_PORT    :', smtpPort);
  console.log('  SMTP_SECURE  :', smtpSecure);
  console.log('  SMTP_USER    :', smtpUser ? `${smtpUser.slice(0, 3)}***${smtpUser.slice(smtpUser.indexOf('@'))}` : '(not set)');
  console.log('  SMTP_PASS    :', smtpPass ? '******** (configured)' : '(not set)');
  console.log('  SMTP_FROM    :', smtpFrom || '(not set)');
  console.log('');

  if (!smtpUser || (!smtpHost && !smtpService)) {
    console.log('❌ Email credentials are not yet configured in .env.');
    console.log('\nTo connect your personal email, add the following lines to your .env file:');
    console.log('--------------------------------------------------');
    console.log('# For Gmail:');
    console.log('SMTP_SERVICE=gmail');
    console.log('SMTP_USER=your_email@gmail.com');
    console.log('SMTP_PASS=your_16_character_app_password');
    console.log('SMTP_FROM="Edward & Christie Workshop" <your_email@gmail.com>');
    console.log('\n# Or for custom SMTP / Outlook:');
    console.log('SMTP_HOST=smtp.office365.com');
    console.log('SMTP_PORT=587');
    console.log('SMTP_SECURE=0');
    console.log('SMTP_USER=your_email@outlook.com');
    console.log('SMTP_PASS=your_password');
    console.log('SMTP_FROM="Edward & Christie Workshop" <your_email@outlook.com>');
    console.log('--------------------------------------------------');
    process.exit(1);
  }

  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (err) {
    console.error('❌ nodemailer module is missing. Run: npm install nodemailer');
    process.exit(1);
  }

  const transportOpts = smtpService
    ? { service: smtpService, auth: { user: smtpUser, pass: smtpPass } }
    : { host: smtpHost, port: smtpPort, secure: smtpSecure, auth: { user: smtpUser, pass: smtpPass } };

  console.log('1. Connecting to mail server...');
  const transporter = nodemailer.createTransport(transportOpts);

  try {
    await transporter.verify();
    console.log('✅ Connection to mail server successful! Credentials are valid.');
  } catch (err) {
    console.error('❌ Connection failed:', err.message);
    if (smtpService === 'gmail' || (smtpHost && smtpHost.includes('gmail'))) {
      console.log('\n💡 Note for Gmail: Regular account passwords cannot be used directly.');
      console.log('   You must enable 2-Step Verification and generate an "App Password":');
      console.log('   1. Visit: https://myaccount.google.com/apppasswords');
      console.log('   2. Create an app password for "WorkshopOne"');
      console.log('   3. Put the generated 16-letter code into SMTP_PASS in .env');
    }
    process.exit(1);
  }

  const targetEmail = process.argv[2] || smtpUser;
  if (targetEmail) {
    console.log(`\n2. Sending test email to: ${targetEmail}...`);
    try {
      const info = await transporter.sendMail({
        from: smtpFrom,
        to: targetEmail,
        subject: 'WorkshopOne Email Test — Connection Verified',
        text: `Hello,\n\nThis is a test email sent from WorkshopOne at ${new Date().toISOString()}.\nYour email connection is working perfectly!`
      });
      console.log('✅ Test email sent successfully!');
      console.log('   Message ID:', info.messageId);
    } catch (sendErr) {
      console.error('❌ Sending test email failed:', sendErr.message);
      process.exit(1);
    }
  }

  console.log('\n🎉 Everything is ready! Emails sent from WorkshopOne will now be delivered via your personal email.');
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
