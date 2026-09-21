/**
 * upgrade 域门面：只转出组合根实际用的符号（installUpgrade），无逻辑。
 *
 * 本域必须在各域装配之前跑（动磁盘者在先）：先跑完存储锚定，各域才读得到 canonical 形态。
 */
export { installUpgrade } from "./impl/service.ts";
