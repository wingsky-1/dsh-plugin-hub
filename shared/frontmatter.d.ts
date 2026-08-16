/** 解析 YAML 布尔（true/false/yes/no/on/off/1/0，大小写不敏感）；非布尔返回 undefined。 */
export declare function parseYamlBool(value: unknown): boolean | undefined;

/**
 * 解析 frontmatter 前若干行里的标量字段（轻量实现，零依赖）。
 * 返回已知键：name / description / whenToUse / hint / recordInput /
 * disableModelInvocation / userInvocable（未知键忽略）。
 */
export declare function parseFrontmatter(content: string): Record<string, unknown>;

/**
 * 通用 frontmatter 解析：返回**全部**键值对（不做已知键过滤）。
 * 供 memory 等需要任意字段（kind/title/date）的文件使用。
 */
export declare function parseFrontmatterAll(content: string): Record<string, string>;

/**
 * 改写 frontmatter 中的某个布尔字段（不存在则追加），原子写回（临时文件 + rename）。
 * @param file SKILL.md 绝对路径。
 */
export declare function setFrontmatterField(file: string, field: string, value: boolean): Record<string, unknown>;
