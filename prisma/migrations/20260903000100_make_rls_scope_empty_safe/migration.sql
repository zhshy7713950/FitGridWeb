DROP POLICY "grid_trade_owner_policy" ON "grid_trades";
CREATE POLICY "grid_trade_owner_policy" ON "grid_trades"
  USING ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''))
  WITH CHECK ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''));

DROP POLICY "import_preview_owner_policy" ON "import_previews";
CREATE POLICY "import_preview_owner_policy" ON "import_previews"
  USING ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''))
  WITH CHECK ("owner_id"::text = NULLIF(current_setting('app.current_user_id', true), ''));
