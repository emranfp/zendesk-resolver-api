require("dotenv").config();

const requiredVars = ["ZD_SUBDOMAIN", "ZD_EMAIL", "ZD_API_TOKEN"];

console.log("ZD_SUBDOMAIN:", process.env.ZD_SUBDOMAIN || "");
console.log("ZD_EMAIL:", process.env.ZD_EMAIL || "");
console.log("ZD_API_TOKEN:", process.env.ZD_API_TOKEN || "");
console.log("ZD_TOKEN set:", Boolean(process.env.ZD_TOKEN));

for (const name of requiredVars) {
  if (!process.env[name]) {
    console.error(`Missing ${name} in .env file`);
  }
}

if (!process.env.ZD_TOKEN) {
  console.error("Missing ZD_TOKEN in .env file");
}

console.log("\nRun this check with: node test-env.js");
