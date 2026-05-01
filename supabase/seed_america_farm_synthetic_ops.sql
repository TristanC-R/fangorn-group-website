-- America Farm realistic demo operations seed.
-- Uses the real farm, owner and existing field ids. It does not create fields,
-- change field boundaries, seed satellite/WMS layers, or add Document Vault files.

do $$
declare
  v_farm_id uuid := '51d8f955-1e1f-44d7-9e09-0241e51a777d';
  v_owner_user_id uuid := '3b8c1a5c-761a-49ec-ade7-5ff1a92dc492';
  v_today date := current_date;
  v_year int := extract(year from current_date)::int;
  f record;
  i int;
  v_crop text;
  v_prev_crop text;
  v_next_crop text;
  v_variety text;
  v_soil text;
  v_area numeric;
  v_yield numeric;
  v_price numeric;
  v_seed_rate numeric;
  v_n_rate numeric;
  v_seed_cost numeric;
  v_fert_cost numeric;
  v_spray_cost numeric;
  v_revenue numeric;
  v_variable_cost numeric;
  v_notes text;
  v_field_attrs jsonb := '{}'::jsonb;
  v_plantings jsonb := '{}'::jsonb;
  v_rotations jsonb := '{}'::jsonb;
  v_yield_store jsonb := '{}'::jsonb;
  v_records jsonb := '[]'::jsonb;
  v_finances jsonb := '[]'::jsonb;
  v_tasks jsonb := '[]'::jsonb;
  v_observations jsonb := '[]'::jsonb;
  v_market_sales jsonb := '[]'::jsonb;
  v_margin_budgets jsonb := '[]'::jsonb;
  v_preharvest jsonb := '[]'::jsonb;
begin
  if not exists (
    select 1 from public.farms
    where id = v_farm_id and owner_user_id = v_owner_user_id
  ) then
    raise exception 'America Farm target not found. Farm %, owner %', v_farm_id, v_owner_user_id;
  end if;

  if not exists (select 1 from public.tilth_fields where farm_id = v_farm_id) then
    raise exception 'America Farm has no fields to seed.';
  end if;

  delete from public.farm_finances
  where farm_id = v_farm_id
    and invoice_ref like 'DEMO-%';

  for f in
    select id, name, row_number() over (order by created_at, name) as rn
    from public.tilth_fields
    where farm_id = v_farm_id
    order by created_at, name
  loop
    i := f.rn;

    v_crop := case f.name
      when 'America Field' then 'Winter wheat'
      when 'Little Isham' then 'Winter barley'
      when 'Little Isham 2' then 'Spring beans'
      when 'High development' then 'Winter oilseed rape'
      when 'Rie Hill' then 'Winter wheat'
      when 'Top Field' then 'Spring barley'
      when 'Elbow' then 'Grass ley'
      when 'Chicken Field' then 'Maize'
      when 'left side' then 'Winter oats'
      when 'South side' then 'Winter beans'
      when 'Ryehill far' then 'Spring wheat'
      when 'Bottom Field' then 'Winter wheat'
      when 'Far top' then 'Spring oats'
      when 'South east' then 'Peas'
      when 'West Side' then 'Winter barley'
      else 'Winter wheat'
    end;

    v_prev_crop := case
      when v_crop in ('Spring beans', 'Winter beans', 'Peas') then 'Winter wheat'
      when v_crop = 'Winter oilseed rape' then 'Winter barley'
      when v_crop = 'Grass ley' then 'Winter wheat'
      when v_crop = 'Maize' then 'Grass ley'
      else 'Spring beans'
    end;

    v_next_crop := case
      when v_crop in ('Winter wheat', 'Spring wheat') then 'Winter beans'
      when v_crop in ('Winter barley', 'Spring barley', 'Winter oats', 'Spring oats') then 'Winter oilseed rape'
      when v_crop in ('Spring beans', 'Winter beans', 'Peas') then 'Winter wheat'
      when v_crop = 'Winter oilseed rape' then 'Winter wheat'
      when v_crop = 'Grass ley' then 'Maize'
      when v_crop = 'Maize' then 'Winter wheat'
      else 'Winter wheat'
    end;

    v_variety := case v_crop
      when 'Winter wheat' then case when f.name = 'America Field' then 'KWS Dawsum' else 'Champion' end
      when 'Spring wheat' then 'Mulika'
      when 'Winter barley' then 'Tardis'
      when 'Spring barley' then 'Laureate'
      when 'Winter oilseed rape' then 'Aurelia'
      when 'Spring beans' then 'Fuego'
      when 'Winter beans' then 'Tundra'
      when 'Winter oats' then 'Mascani'
      when 'Spring oats' then 'Canyon'
      when 'Maize' then 'LG Prospect'
      when 'Peas' then 'Karpate'
      else v_crop
    end;

    v_soil := case
      when f.name in ('America Field', 'Rie Hill', 'Bottom Field') then 'Loam'
      when f.name in ('Top Field', 'Elbow', 'West Side') then 'Clay loam'
      when f.name in ('Little Isham 2', 'South east', 'Ryehill far') then 'Sandy loam'
      when f.name in ('High development', 'South side') then 'Silty clay loam'
      else 'Loam'
    end;

    v_area := greatest(3.0, round((6.8 + i * 2.9)::numeric, 2));
    v_yield := round((case
      when f.name = 'America Field' then 7.35
      when v_crop = 'Winter wheat' then 8.45 - (i % 3) * 0.18
      when v_crop = 'Spring wheat' then 6.15
      when v_crop = 'Winter barley' then 7.05
      when v_crop = 'Spring barley' then 6.35
      when v_crop = 'Winter oilseed rape' then 3.75
      when v_crop = 'Spring beans' then 4.45
      when v_crop = 'Winter beans' then 4.75
      when v_crop = 'Winter oats' then 6.05
      when v_crop = 'Spring oats' then 5.55
      when v_crop = 'Maize' then 39.5
      when v_crop = 'Peas' then 4.15
      when v_crop = 'Grass ley' then 9.8
      else 7.2
    end)::numeric, 2);

    v_price := case
      when v_crop ilike '%wheat%' then 180
      when v_crop ilike '%barley%' then 162
      when v_crop ilike '%oats%' then 154
      when v_crop ilike '%rape%' then 372
      when v_crop ilike '%beans%' then 222
      when v_crop = 'Peas' then 232
      when v_crop = 'Maize' then 42
      when v_crop = 'Grass ley' then 118
      else 180
    end;

    v_seed_rate := case
      when v_crop ilike '%beans%' then 210
      when v_crop = 'Winter oilseed rape' then 4.5
      when v_crop = 'Grass ley' then 28
      when v_crop = 'Maize' then 1
      when v_crop = 'Peas' then 230
      else 185
    end;

    v_n_rate := case
      when v_crop ilike '%beans%' or v_crop = 'Peas' then 0
      when v_crop = 'Grass ley' then 80
      when v_crop = 'Maize' then 115
      when v_crop = 'Winter oilseed rape' then 205
      else 185
    end;

    v_seed_cost := round(v_area * case
      when v_crop = 'Winter oilseed rape' then 78
      when v_crop = 'Maize' then 126
      when v_crop in ('Spring beans', 'Winter beans', 'Peas') then 152
      when v_crop = 'Grass ley' then 92
      else 118
    end, 2);
    v_fert_cost := round(v_area * case when v_n_rate = 0 then 28 else 165 + (v_n_rate * 0.22) end, 2);
    v_spray_cost := round(v_area * case
      when v_crop = 'Grass ley' then 42
      when v_crop = 'Maize' then 86
      when v_crop ilike '%beans%' or v_crop = 'Peas' then 96
      when v_crop = 'Winter oilseed rape' then 142
      else 128
    end, 2);
    v_revenue := round(v_area * v_yield * v_price, 2);
    v_variable_cost := v_seed_cost + v_fert_cost + v_spray_cost;
    v_notes := case
      when f.name = 'America Field' then 'Main attention field for the demo: good wheat potential, but paler tramline strips suggest compaction after wet spring traffic.'
      when v_crop in ('Spring beans', 'Winter beans', 'Peas') then 'Break crop reducing nitrogen requirement and improving following wheat potential.'
      when v_crop = 'Grass ley' then 'Livestock support block used for grazing/silage and soil rest in the rotation.'
      else 'Commercial combinable crop field in the current America Farm rotation.'
    end;

    v_field_attrs := jsonb_set(v_field_attrs, array[f.id::text], jsonb_build_object(
      'crop', v_crop,
      'soil', v_soil,
      'landUse', case when v_crop = 'Grass ley' then 'Grass' else 'Arable' end,
      'areaHa', v_area,
      'variety', v_variety,
      'establishment', case when v_crop ilike 'Spring%' or v_crop = 'Maize' or v_crop = 'Peas' then 'Spring drilled' else 'Autumn drilled' end,
      'risk', case when f.name = 'America Field' then 'Check compaction and septoria risk on tramline areas' else 'Normal seasonal monitoring' end,
      'notes', v_notes
    ), true);

    v_plantings := jsonb_set(v_plantings, array[f.id::text], jsonb_build_array(jsonb_build_object(
      'id', 'demo-planting-' || i || '-' || v_year,
      'crop', v_crop,
      'variety', v_variety,
      'plantingDate', case when v_crop ilike 'Spring%' or v_crop = 'Maize' or v_crop = 'Peas' then make_date(v_year, 3, 21) else make_date(v_year - 1, 10, 5) end,
      'seedRate', v_seed_rate,
      'notes', v_notes,
      'createdAt', now(),
      'sourceKey', 'demo:planting:' || f.id
    )), true);

    v_rotations := jsonb_set(v_rotations, array[f.id::text], jsonb_build_array(
      jsonb_build_object('id','demo-rot-' || i || '-' || (v_year - 1),'year',v_year - 1,'season','autumn','startMonth',9,'crop',v_prev_crop,'notes','Last season crop'),
      jsonb_build_object('id','demo-rot-' || i || '-' || v_year,'year',v_year,'season',case when v_crop ilike 'Spring%' or v_crop = 'Maize' or v_crop = 'Peas' then 'spring' else 'autumn' end,'startMonth',case when v_crop ilike 'Spring%' or v_crop = 'Maize' or v_crop = 'Peas' then 3 else 9 end,'crop',v_crop,'notes','Current demo crop'),
      jsonb_build_object('id','demo-rot-' || i || '-' || (v_year + 1),'year',v_year + 1,'season','autumn','startMonth',9,'crop',v_next_crop,'notes','Planned next crop')
    ), true);

    v_yield_store := jsonb_set(
      v_yield_store,
      array[(v_year - 1)::text],
      coalesce(v_yield_store -> (v_year - 1)::text, '{}'::jsonb)
        || jsonb_build_object(f.id::text, round((v_yield - 0.35)::numeric, 2)),
      true
    );
    v_yield_store := jsonb_set(
      v_yield_store,
      array[v_year::text],
      coalesce(v_yield_store -> v_year::text, '{}'::jsonb)
        || jsonb_build_object(f.id::text, v_yield),
      true
    );

    v_records := v_records || jsonb_build_array(
      jsonb_build_object('id','demo-rec-' || i || '-drill','createdAt',now(),'fieldId',f.id,'fieldName',f.name,'productId','demo-seed','rate',v_seed_rate,'date',case when v_crop ilike 'Spring%' or v_crop = 'Maize' or v_crop = 'Peas' then make_date(v_year, 3, 21) else make_date(v_year - 1, 10, 5) end,'operator','Tristan','notes','Drilled ' || v_variety || ' after ' || v_prev_crop || '. Seed-bed conditions recorded as ' || case when v_soil ilike '%clay%' then 'firm but workable' else 'good' end || '.','area',v_area,'sourceKey','demo:record:' || f.id || ':drill'),
      jsonb_build_object('id','demo-rec-' || i || '-fert','createdAt',now(),'fieldId',f.id,'fieldName',f.name,'productId','demo-liquid-n','rate',v_n_rate,'date',make_date(v_year, 3, 16),'operator','Tristan','notes',case when v_n_rate = 0 then 'No bagged nitrogen planned because this is a pulse crop.' else 'Main nitrogen split matched to crop demand and soil conditions.' end,'area',v_area,'sourceKey','demo:record:' || f.id || ':fertiliser'),
      jsonb_build_object('id','demo-rec-' || i || '-weed','createdAt',now(),'fieldId',f.id,'fieldName',f.name,'productId','demo-herbicide','rate',case when v_crop = 'Grass ley' then 0 else 1.05 end,'date',make_date(v_year, 3, 29),'operator','Sam','notes',case when v_crop = 'Grass ley' then 'No herbicide applied to grass ley.' else 'Spring weed tidy-up following crop inspection.' end,'area',v_area,'sourceKey','demo:record:' || f.id || ':herbicide'),
      jsonb_build_object('id','demo-rec-' || i || '-fung','createdAt',now(),'fieldId',f.id,'fieldName',f.name,'productId','demo-t1-fungicide','rate',case when v_crop in ('Grass ley','Maize') then 0 else case when f.name = 'America Field' then 0.9 else 0.75 end end,'date',make_date(v_year, 4, 19),'operator','Tristan','notes',case when f.name = 'America Field' then 'T1 fungicide applied after field walk found paler strips and elevated septoria risk.' when v_crop in ('Grass ley','Maize') then 'No T1 fungicide required for this crop.' else 'T1 fungicide applied at standard farm rate.' end,'area',v_area,'sourceKey','demo:record:' || f.id || ':fungicide')
    );

    v_finances := v_finances || jsonb_build_array(
      jsonb_build_object('id','demo-fin-' || i || '-seed','type','expense','date',make_date(v_year - 1, 9, 28),'amount',v_seed_cost,'vatAmount',round(v_seed_cost * 0.2, 2),'category','seed','description',v_variety || ' seed for ' || f.name,'counterparty','Frontier Agriculture','invoiceRef','DEMO-SEED-' || lpad(i::text, 3, '0'),'fieldId',f.id,'notes','Seed cost matched to crop plan','sourceKey','demo:finance:' || f.id || ':seed'),
      jsonb_build_object('id','demo-fin-' || i || '-fert','type','expense','date',make_date(v_year, 3, 20),'amount',v_fert_cost,'vatAmount',round(v_fert_cost * 0.2, 2),'category','fertiliser','description','Fertiliser programme for ' || f.name,'counterparty','Agrii Inputs','invoiceRef','DEMO-FERT-' || lpad(i::text, 3, '0'),'fieldId',f.id,'notes','Fertiliser cost follows nitrogen plan','sourceKey','demo:finance:' || f.id || ':fert'),
      jsonb_build_object('id','demo-fin-' || i || '-spray','type','expense','date',make_date(v_year, 4, 25),'amount',v_spray_cost,'vatAmount',round(v_spray_cost * 0.2, 2),'category','chemical','description','Crop protection for ' || f.name,'counterparty','AgChem Supplies','invoiceRef','DEMO-SPRAY-' || lpad(i::text, 3, '0'),'fieldId',f.id,'notes','Spray budget tied to records','sourceKey','demo:finance:' || f.id || ':spray'),
      jsonb_build_object('id','demo-fin-' || i || '-sale','type','income','date',make_date(v_year, 8, 20),'amount',v_revenue,'vatAmount',0,'category','grain_sale','description',v_crop || ' sale from ' || f.name,'counterparty','Openfield Agriculture','invoiceRef','DEMO-SALE-' || lpad(i::text, 3, '0'),'fieldId',f.id,'notes','Sale value from demo yield and price assumptions','sourceKey','demo:finance:' || f.id || ':sale')
    );

    insert into public.farm_finances (farm_id, field_id, txn_type, txn_date, amount, vat_amount, category, description, counterparty, invoice_ref, notes)
    values
      (v_farm_id, f.id, 'expense', make_date(v_year, 3, 20), v_fert_cost, round(v_fert_cost * 0.2, 2), 'fertiliser', 'Fertiliser programme for ' || f.name, 'Agrii Inputs', 'DEMO-FERT-' || lpad(i::text, 3, '0'), 'Demo cost matched to field operations'),
      (v_farm_id, f.id, 'expense', make_date(v_year, 4, 25), v_spray_cost, round(v_spray_cost * 0.2, 2), 'chemical', 'Crop protection for ' || f.name, 'AgChem Supplies', 'DEMO-SPRAY-' || lpad(i::text, 3, '0'), 'Demo spray cost matched to field records'),
      (v_farm_id, f.id, 'income', make_date(v_year, 8, 20), v_revenue, 0, 'grain_sale', v_crop || ' sale from ' || f.name, 'Openfield Agriculture', 'DEMO-SALE-' || lpad(i::text, 3, '0'), 'Demo sale value from yield data');

    v_market_sales := v_market_sales || jsonb_build_array(
      jsonb_build_object('id','demo-market-sale-' || i,'fieldId',f.id,'fieldName',f.name,'commodity',v_crop,'tonnes',round(v_area * v_yield, 2),'price',v_price,'buyer','Openfield Agriculture','date',make_date(v_year, 8, 20),'notes','Forward priced tranche for demo margin reporting','sourceKey','demo:market-sale:' || f.id)
    );

    v_margin_budgets := v_margin_budgets || jsonb_build_array(
      jsonb_build_object('id','demo-margin-' || i,'fieldId',f.id,'fieldName',f.name,'year',v_year,'crop',v_crop,'areaHa',v_area,'yieldTHa',v_yield,'pricePerTonne',v_price,'expectedRevenue',v_revenue,'seedCost',v_seed_cost,'fertiliserCost',v_fert_cost,'sprayCost',v_spray_cost,'variableCosts',v_variable_cost,'grossMargin',v_revenue - v_variable_cost,'grossMarginPerHa',round((v_revenue - v_variable_cost) / nullif(v_area, 0), 2),'notes','Demo margin aligns yield, finance and spray records','sourceKey','demo:margin:' || f.id)
    );

    v_tasks := v_tasks || jsonb_build_array(
      jsonb_build_object('id','demo-task-' || i || '-scout','title','Scout ' || f.name || ' before next input decision','dueDate',v_today + ((i % 8) + 1),'category','field_walk','priority',case when f.name = 'America Field' then 'high' else 'medium' end,'status','pending','fieldId',f.id,'notes',case when f.name = 'America Field' then 'Check paler tramline strips, compaction and septoria on America Field.' else 'Confirm crop condition before next pass on ' || f.name end,'sourceKey','demo:task:' || f.id || ':scout')
    );

    v_observations := v_observations || jsonb_build_array(
      jsonb_build_object('id','demo-obs-' || i,'fieldId',f.id,'fieldName',f.name,'date',v_today - ((i % 10) + 2),'type',case when f.name = 'America Field' then 'crop_health' when v_soil ilike '%clay%' then 'soil_condition' else 'field_walk' end,'severity',case when f.name = 'America Field' then 'medium' else 'low' end,'notes',case when f.name = 'America Field' then 'Paler strips visible on tramlines; check rooting and compaction before further nitrogen.' when v_soil ilike '%clay%' then 'Headland carrying wheel marks after wet spell; avoid unnecessary trafficking.' else 'Crop even and no immediate action beyond normal monitoring.' end,'sourceKey','demo:observation:' || f.id)
    );

    v_preharvest := v_preharvest || jsonb_build_array(
      jsonb_build_object('id','demo-preharvest-' || i,'fieldId',f.id,'fieldName',f.name,'crop',v_crop,'status','pending','notes','Confirm latest spray interval and grain store destination before harvest.','sourceKey','demo:preharvest:' || f.id)
    );
  end loop;

  v_finances := v_finances || jsonb_build_array(
    jsonb_build_object('id','demo-fin-fangorn','type','expense','date',v_today - 48,'amount',1842.60,'vatAmount',307.10,'category','contractor','description','Fangorn Group Limited platform support and field mapping invoice','counterparty','Fangorn Group Limited','invoiceRef','DEMO-FANGORN-0426','paymentStatus','unpaid','status','unpaid','notes','Demo unpaid supplier invoice for assistant finance questions','sourceKey','demo:finance:fangorn-unpaid'),
    jsonb_build_object('id','demo-fin-rent','type','expense','date',make_date(v_year, 3, 25),'amount',17500,'vatAmount',0,'category','rent','description','Quarterly land rent for America Farm','counterparty','Isham Estate','invoiceRef','DEMO-RENT-Q1','paymentStatus','paid','status','paid','notes','Standing land rent payment','sourceKey','demo:finance:rent-q1'),
    jsonb_build_object('id','demo-fin-sfi','type','income','date',make_date(v_year, 5, 10),'amount',21450,'vatAmount',0,'category','subsidy','description','SFI quarterly payment','counterparty','RPA','invoiceRef','DEMO-SFI-Q1','paymentStatus','received','status','paid','notes','Scheme income for cover and soil actions','sourceKey','demo:finance:sfi-q1')
  );

  insert into public.farm_finances (farm_id, txn_type, txn_date, amount, vat_amount, category, description, counterparty, invoice_ref, notes)
  values
    (v_farm_id, 'expense', v_today - 48, 1842.60, 307.10, 'contractor', 'Fangorn Group Limited platform support and field mapping invoice', 'Fangorn Group Limited', 'DEMO-FANGORN-0426', 'Demo unpaid payable mirrored in farm_app_data'),
    (v_farm_id, 'expense', make_date(v_year, 3, 25), 17500, 0, 'rent', 'Quarterly land rent for America Farm', 'Isham Estate', 'DEMO-RENT-Q1', 'Paid standing rent'),
    (v_farm_id, 'income', make_date(v_year, 5, 10), 21450, 0, 'subsidy', 'SFI quarterly payment', 'RPA', 'DEMO-SFI-Q1', 'Scheme income');

  insert into public.farm_app_data (farm_id, namespace, data)
  values
    (v_farm_id, 'custom_products', '[
      {"id":"demo-liquid-n","name":"Liquid nitrogen 30N","category":"fertiliser","unit":"L","defaultRate":185,"costPerUnit":0.42,"ai":"UAN","custom":true},
      {"id":"demo-t1-fungicide","name":"Ascra Xpro style T1 mix","category":"fungicide","unit":"L/ha","defaultRate":0.75,"costPerUnit":36.50,"ai":"bixafen + fluopyram + prothioconazole","custom":true},
      {"id":"demo-herbicide","name":"Residual herbicide mix","category":"herbicide","unit":"L/ha","defaultRate":1.05,"costPerUnit":27.00,"ai":"flufenacet + diflufenican","custom":true},
      {"id":"demo-seed","name":"Certified combinable crop seed","category":"seed","unit":"kg/ha","defaultRate":185,"costPerUnit":0.62,"ai":"","custom":true}
    ]'::jsonb),
    (v_farm_id, 'fieldAttrs', v_field_attrs),
    (v_farm_id, 'plantings', v_plantings),
    (v_farm_id, 'rotations', v_rotations),
    (v_farm_id, 'yield', v_yield_store),
    (v_farm_id, 'records', v_records),
    (v_farm_id, 'finances', v_finances),
    (v_farm_id, 'tasks', v_tasks || jsonb_build_array(
      jsonb_build_object('id','demo-task-fangorn','title','Pay or query Fangorn invoice DEMO-FANGORN-0426','dueDate',v_today + 1,'category','finance','priority','urgent','status','pending','notes','Invoice is intentionally unpaid for assistant demo questions.','sourceKey','demo:task:fangorn-invoice'),
      jsonb_build_object('id','demo-task-redtractor','title','Complete spray record sign-off before Red Tractor review','dueDate',v_today + 9,'category','compliance','priority','medium','status','pending','notes','Cross-check spray records, stock book and operator names.','sourceKey','demo:task:red-tractor')
    )),
    (v_farm_id, 'observations', v_observations),
    (v_farm_id, 'inventory', jsonb_build_array(
      jsonb_build_object('id','demo-store-n','name','Liquid nitrogen 30N','category','fertiliser','unit','L','quantity',4200,'unitCost',0.42,'batchNumber','N24-0418','supplier','Agrii Inputs','purchaseDate',make_date(v_year,2,18),'expiryDate','','storageLocation','Main yard tank','lowStockThreshold',900,'notes','Enough for final split on wheat and barley.','adjustments',jsonb_build_array(jsonb_build_object('date',v_today - 12,'delta',-1800,'resultQty',4200,'sourceKey','demo:store:n-used')),'sourceKey','demo:store:n'),
      jsonb_build_object('id','demo-store-fung','name','Ascra Xpro style T1 mix','category','chemical','unit','L','quantity',62,'unitCost',36.5,'batchNumber','AX24-118','supplier','AgChem Supplies','purchaseDate',make_date(v_year,3,4),'expiryDate',make_date(v_year+2,11,30),'storageLocation','Chemical store bay 2','mappNumber','19964','lowStockThreshold',15,'notes','T1 stock after America Field pass.','adjustments','[]'::jsonb,'sourceKey','demo:store:fungicide'),
      jsonb_build_object('id','demo-store-herb','name','Residual herbicide mix','category','chemical','unit','L','quantity',38,'unitCost',27,'batchNumber','RH24-033','supplier','AgChem Supplies','purchaseDate',make_date(v_year,2,24),'expiryDate',make_date(v_year+2,10,31),'storageLocation','Chemical store bay 1','mappNumber','18652','lowStockThreshold',12,'notes','Enough for late headland tidy-up.','adjustments','[]'::jsonb,'sourceKey','demo:store:herbicide'),
      jsonb_build_object('id','demo-store-feed','name','Beef finisher blend','category','feed','unit','t','quantity',18,'unitCost',286,'batchNumber','BF24-07','supplier','Mole Valley Farmers','purchaseDate',v_today - 9,'expiryDate','','storageLocation','Feed bay','lowStockThreshold',5,'notes','Used by finishing cattle group.','adjustments','[]'::jsonb,'sourceKey','demo:store:feed')
    )),
    (v_farm_id, 'contacts', jsonb_build_array(
      jsonb_build_object('id','demo-contact-fangorn','name','Fangorn Accounts','company','Fangorn Group Limited','role','supplier','phone','01536 000000','email','accounts@fangorn.example','address','Isham Road, Northamptonshire','notes','Creditor with unpaid demo invoice DEMO-FANGORN-0426.','sourceKey','demo:contact:fangorn'),
      jsonb_build_object('id','demo-contact-agronomy','name','Sarah Whitmore','company','Ise Valley Agronomy','role','agronomist','phone','07700 900100','email','sarah.whitmore@example.com','address','Kettering, Northamptonshire','notes','Advises on wheat disease, pulses and OSR.','sourceKey','demo:contact:agronomy'),
      jsonb_build_object('id','demo-contact-vet','name','Northants Farm Vets','company','Northants Farm Vets','role','vet','phone','01536 900200','email','farmvets@example.com','address','Market Harborough','notes','Livestock health plan and medicine records.','sourceKey','demo:contact:vet'),
      jsonb_build_object('id','demo-contact-openfield','name','Mark Ellis','company','Openfield Agriculture','role','buyer','phone','01476 900300','email','mark.ellis@example.com','address','Grantham','notes','Grain buyer for wheat, barley and beans.','sourceKey','demo:contact:openfield')
    )),
    (v_farm_id, 'livestock', (
      select jsonb_agg(jsonb_build_object(
        'id','demo-cow-' || n,
        'tag','UK123456 70' || lpad(n::text,3,'0'),
        'name',case when n <= 6 then 'Heifer ' || n else '' end,
        'species','cattle',
        'breed',case when n % 3 = 0 then 'Angus X' else 'British Blue X' end,
        'sex',case when n % 5 = 0 then 'male' else 'female' end,
        'dob',(v_today - (450 + n * 18))::text,
        'sireTag','UK123456 60001',
        'damTag','UK123456 50' || lpad(n::text,3,'0'),
        'status','active',
        'notes','Finishing group grazing Elbow and left side grass before yard finishing.'
      ))
      from generate_series(1,18) as n
    )),
    (v_farm_id, 'livestock_movements', jsonb_build_array(
      jsonb_build_object('id','demo-move-on','direction','on','date',v_today - 65,'fromCph','12/345/0001','toCph','12/345/6789','reason','Store cattle purchase','haulier','Isham Haulage','batchRef','ISH-STORE-APR','animalCount',12,'linkedTag','','notes','Bought as forward stores for summer grazing.'),
      jsonb_build_object('id','demo-move-off','direction','off','date',v_today - 18,'fromCph','12/345/6789','toCph','12/345/0022','reason','Finished cattle sale','haulier','Isham Haulage','batchRef','ISH-FINISHED-APR','animalCount',4,'linkedTag','','notes','Finished cattle sold after 90 day feed period.')
    )),
    (v_farm_id, 'livestock_medicines', jsonb_build_array(
      jsonb_build_object('id','demo-med-fluke','date',v_today - 14,'animalTag','','product','Closantel drench','batchNumber','CL24-019','dosage','10 ml / 50 kg','route','oral','withdrawalMeatDays',56,'withdrawalMilkDays',0,'administeredBy','Tristan','vetName','Northants Farm Vets','reason','Fluke risk control after wet spring','notes','Batch treatment for finishing group.'),
      jsonb_build_object('id','demo-med-lame','date',v_today - 5,'animalTag','UK123456 70003','product','Oxytetracycline LA','batchNumber','OTC24-044','dosage','1 ml / 10 kg','route','injection','withdrawalMeatDays',28,'withdrawalMilkDays',7,'administeredBy','Tristan','vetName','Northants Farm Vets','reason','Lameness treatment','notes','Review before sale group selection.')
    )),
    (v_farm_id, 'livestock_breeding', jsonb_build_array(
      jsonb_build_object('id','demo-breed-service','type','service','date',v_today - 42,'expectedDate',v_today + 241,'damTag','UK123456 70004','sireTag','UK123456 60001','offspringCount',1,'notes','Natural service recorded for demo herd.'),
      jsonb_build_object('id','demo-breed-scan','type','scan','date',v_today - 7,'expectedDate',v_today + 188,'damTag','UK123456 70006','sireTag','UK123456 60001','offspringCount',1,'notes','Positive scan; keep on calving watch list.')
    )),
    (v_farm_id, 'audit_checklists', jsonb_build_object(
      'red_tractor', jsonb_build_array(
        jsonb_build_object('id','demo-audit-spray','title','Spray records checked against stock book','status','needs_review','notes','America Field T1 pass needs operator signature before audit.','sourceKey','demo:audit:spray'),
        jsonb_build_object('id','demo-audit-medicine','title','Medicine withdrawal periods current','status','ok','notes','Closantel and oxytet withdrawals visible in medicine register.','sourceKey','demo:audit:medicine')
      ),
      'assistant', jsonb_build_array(
        jsonb_build_object('id','demo-audit-fangorn','title','Review unpaid Fangorn invoice','status','pending','notes','Unpaid finance row should be picked up by assistant finance tool.','sourceKey','demo:audit:fangorn')
      )
    )),
    (v_farm_id, 'preharvest_safety', v_preharvest),
    (v_farm_id, 'market_sales', v_market_sales),
    (v_farm_id, 'market_purchases', jsonb_build_array(
      jsonb_build_object('id','demo-purchase-n','commodity','Liquid nitrogen 30N','quantity',12000,'unit','L','price',0.42,'supplier','Agrii Inputs','date',make_date(v_year,2,18),'sourceKey','demo:purchase:n'),
      jsonb_build_object('id','demo-purchase-feed','commodity','Beef finisher blend','quantity',24,'unit','t','price',286,'supplier','Mole Valley Farmers','date',v_today - 9,'sourceKey','demo:purchase:feed')
    )),
    (v_farm_id, 'market_watchlist', jsonb_build_array(
      jsonb_build_object('id','demo-watch-wheat','marketId','feed_wheat','target','GBP 190/t','direction','above','notes','Consider selling remaining wheat if November feed wheat trades above target.','sourceKey','demo:watch:wheat'),
      jsonb_build_object('id','demo-watch-beans','marketId','feed_beans','target','GBP 230/t','direction','above','notes','Beans target for South side and Little Isham 2.','sourceKey','demo:watch:beans')
    )),
    (v_farm_id, 'margin_budgets', v_margin_budgets)
  on conflict (farm_id, namespace) do update set
    data = excluded.data,
    updated_at = now();

  raise notice 'Seeded coherent America Farm demo data for % existing fields. Documents, satellite/WMS and field boundaries were not touched.',
    (select count(*) from public.tilth_fields where farm_id = v_farm_id);
end $$;
