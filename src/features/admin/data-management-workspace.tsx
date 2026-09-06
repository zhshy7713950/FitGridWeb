import { DataVault } from "./data-vault";
import type { PortableBackupSummary } from "./types";
import styles from "./admin.module.css";

export function DataManagementWorkspace({
  initialBackups,
}: {
  initialBackups?: PortableBackupSummary[];
}) {
  return (
    <section className={styles.workspace} aria-labelledby="data-management-title">
      <header className={styles.heading}>
        <div>
          <p>Server custody · 管理完整数据快照</p>
          <h1 id="data-management-title">数据管理</h1>
        </div>
        <span className={styles.authority}>管理员权限已验证</span>
      </header>
      <DataVault initialBackups={initialBackups} />
    </section>
  );
}
