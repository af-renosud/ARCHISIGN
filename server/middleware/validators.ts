import type { Request, Response, NextFunction } from "express";

export function validateId(req: Request, res: Response, next: NextFunction) {
  const id = parseInt(req.params.id as string);
  if (isNaN(id)) {
    return res.status(400).json({ message: "Invalid ID" });
  }
  (req as any).validatedId = id;
  next();
}
