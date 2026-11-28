
const API_BASE_URL = process.env.TEST_API_URL?.replace(/\/+$/, "");
if (!API_BASE_URL) {
  throw new Error("TEST_API_URL is required for HTTP integration tests.");
}
const API_URL = `${API_BASE_URL}/memories`;

async function testAuth() {
  const tests = [
    {
      name: "Missing token",
      headers: {}
    },
    {
      name: "Invalid token",
      headers: {
        Authorization: "Bearer invalid.jwt.token"
      }
    }
  ];

  for (const test of tests) {
    const response = await fetch(API_URL, {
      method: "GET",
      headers: test.headers
    });

    console.log(
      `${test.name}: HTTP ${response.status}`
    );
  }
}

testAuth();
