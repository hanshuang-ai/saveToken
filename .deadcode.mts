import { Project } from "ts-morph";

const project = new Project({ tsConfigFilePath: "E:/WT/saveToken/tsconfig.json" });
project.addSourceFilesAtPaths("E:/WT/saveToken/tests/**/*.ts");
project.addSourceFilesAtPaths("E:/WT/saveToken/hooks/**/*.ts");

const rel = (p: string) => p.replace("E:/WT/saveToken/", "");

for (const sf of project.getSourceFiles()) {
  const fp = sf.getFilePath();
  const base = rel(fp);
  const exports = sf.getExportedDeclarations();
  for (const [name, decls] of exports) {
    const extFiles = new Set<string>();
    let total = 0;
    for (const d of decls) {
      const refs = d.findReferences();
      total += refs.length;
      for (const r of refs) {
        try {
          const rfp = r.getNode().getSourceFile().getFilePath();
          if (rfp !== fp) extFiles.add(rel(rfp));
        } catch {
          /* ignore */
        }
      }
    }
    if (extFiles.size === 0) {
      console.log(`DEAD-EXPORT\t${base}\t${name}\textRefFiles=${extFiles.size}\ttotalRefs=${total}`);
    }
  }
}
console.log("DONE");
