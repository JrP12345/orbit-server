/**
 * Role enforcement middleware.
 * Usage: requireRole("OWNER") or requireRole("OWNER", "MEMBER")
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Authentication required" });
    }

    // Backward compat: tokens created before role field default to OWNER
    const userRole = req.user.role || "OWNER";

    if (!roles.includes(userRole)) {
      return res
        .status(403)
        .json({ message: "You do not have permission to perform this action" });
    }

    next();
  };
}
