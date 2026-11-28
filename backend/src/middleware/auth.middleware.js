import { createRemoteJWKSet, jwtVerify } from "jose";

import { getAuthVerificationConfig } from "../config/integration-env.js";

const authConfig = getAuthVerificationConfig();
let jwks;

function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(authConfig.jwksUrl), {
      timeoutDuration: 10000
    });
  }
  return jwks;
}

export async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized"
      });
    }

    const token = authHeader.slice(7);
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer: authConfig.issuer,
      audience: authConfig.issuer
    });

    if (typeof payload.sub !== "string" || !payload.sub) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized / Invalid"
      });
    }

    req.user = { id: payload.sub };
    next();
  } catch (error) {
    console.error("Authentication error:", error);
    return res.status(401).json({
      success: false,
      error: "Unauthorized / Invalid"
    });
  }
}
