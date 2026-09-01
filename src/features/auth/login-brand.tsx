import styles from "./login.module.css";

export function LoginBrand() {
  return (
    <aside className={styles.brand}>
      <div className={styles.wordmark}><span>FG</span> FitGrid</div>
      <svg className={styles.ladder} viewBox="0 0 520 240" aria-hidden="true">
        <g className={styles.gridLines}>
          <path d="M0 40H520M0 90H520M0 140H520M0 190H520" />
          <path d="M40 0V240M120 0V240M200 0V240M280 0V240M360 0V240M440 0V240" />
        </g>
        <path className={styles.stepLine} d="M32 48H150V94H270V142H390V190H488" />
        <g className={styles.nodes}>
          <circle cx="150" cy="48" r="6" />
          <circle cx="270" cy="94" r="6" />
          <circle cx="390" cy="142" r="6" />
          <circle cx="488" cy="190" r="6" />
        </g>
      </svg>
      <p className={styles.eyebrow}>Rule-based strategy workspace</p>
      <h1>让每一道网格<br />都有清晰依据</h1>
      <p className={styles.brandCopy}>集中管理参数、档位与计算结果，只保留对策略决策有用的信息。</p>
    </aside>
  );
}
