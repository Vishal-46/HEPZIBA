const nodemailer = require('nodemailer');

let transporterPromise = (async () => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    let testAccount = await nodemailer.createTestAccount();
    console.log('----------------------');
    console.log('Ethereal SMTP created for you!');
    console.log('SMTP_USER=' + testAccount.user);
    console.log('SMTP_PASS=' + testAccount.pass);
    console.log('Login Ethereal: https://ethereal.email/login/');
    console.log('----------------------');

    return nodemailer.createTransport({
      host: testAccount.smtp.host,
      port: testAccount.smtp.port,
      auth: { user: testAccount.user, pass: testAccount.pass }
    });
  } else {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
})();

module.exports = {
  sendMail: async (options) => {
    const transporter = await transporterPromise;
    let info = await transporter.sendMail(options);
    if (nodemailer.getTestMessageUrl) {
      console.log('\n--- Ethereal preview: ' + nodemailer.getTestMessageUrl(info));
    }
    return info;
  }
};
