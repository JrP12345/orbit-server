export function requirePermission(...required) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    if (req.user.role === "OWNER") return next();
    const has = required.some((p) => (req.user.permissions || []).includes(p));
    if (!has) return res.status(403).json({ message: "You do not have permission to perform this action" });
    next();
  };
}

export function requireAllPermissions(...required) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ message: "Authentication required" });
    if (req.user.role === "OWNER") return next();
    const has = required.every((p) => (req.user.permissions || []).includes(p));
    if (!has) return res.status(403).json({ message: "You do not have permission to perform this action" });
    next();
  };
}
