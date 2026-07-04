import { Router, type IRouter } from "express";
import healthRouter from "./health";
import tokensRouter from "./tokens";
import poolsRouter from "./pools";
import swapRouter from "./swap";
import transactionsRouter from "./transactions";

const router: IRouter = Router();

router.use(healthRouter);
router.use(tokensRouter);
router.use(poolsRouter);
router.use(swapRouter);
router.use(transactionsRouter);

export default router;
