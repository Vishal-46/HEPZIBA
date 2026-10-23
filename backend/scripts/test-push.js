// Simple script to test push notifications to a token or user ID
const { sendPush, tokensForUser, isExpoPushToken } = require('../utils/push');

async function main() {
  const target = process.argv[2];
  const title = process.argv[3] || 'Hepziba Clinic';
  const body = process.argv[4] || 'Test notification: Your visit notification is working!';

  if (!target) {
    console.log('Usage: node scripts/test-push.js <ExpoPushToken OR userId> [title] [body]');
    console.log('Example: node scripts/test-push.js "ExpoPushToken[xxxxxxxxxxxxxx]"');
    console.log('Example: node scripts/test-push.js 12');
    process.exit(1);
  }

  let tokens = [];
  if (isExpoPushToken(target)) {
    tokens = [target];
  } else if (/^\d+$/.test(target)) {
    console.log(`Looking up push tokens for user ID: ${target}...`);
    tokens = await tokensForUser(Number(target));
    if (!tokens.length) {
      console.error(`No push tokens found in DB for user ID ${target}.`);
      process.exit(1);
    }
  } else {
    // Attempt anyway in case of raw token
    tokens = [target];
  }

  console.log(`Sending test push to ${tokens.length} token(s):`, tokens);
  await sendPush(tokens, title, body, { test: true });
  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
