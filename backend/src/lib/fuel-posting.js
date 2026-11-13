import {audit} from '../db.js';

export async function postFuelRecord(connection, vehicleId, body, userId, ip) {
    const [[vehicle]]=await connection.execute('SELECT * FROM fleet WHERE id=? FOR UPDATE',[vehicleId]);
    if(!vehicle)throw Object.assign(new Error('Vehicle not found'),{status:404});
    if(body.odometer<Number(vehicle.odometer))throw Object.assign(new Error(
      `The odometer cannot go backwards — ${vehicle.registration} was last recorded at ${vehicle.odometer} km`),{status:409});
    const projectId=body.projectId===undefined?vehicle.project_id:body.projectId;
    const [[fuelFloat]]=body.fuelFloatId ? await connection.execute(`SELECT id,name,company_id companyId,project_id projectId
      FROM petty_cash_floats WHERE id=? AND account_type='Fuel' AND active=1 FOR UPDATE`,[body.fuelFloatId]) : [[null]];
    if(body.fuelFloatId&&!fuelFloat)throw Object.assign(new Error('Choose an active fuel float before recording fuel'),{status:400});
    let companyId=body.companyId||null;
    // Floats are shared. companyId identifies this fuel payment, not the account owner.
    if(projectId){
      const [[project]]=await connection.execute('SELECT id,company_id companyId FROM projects WHERE id=? AND active=1',[projectId]);
      if(!project)throw Object.assign(new Error('Project site not found'),{status:400});
      if(companyId&&Number(project.companyId)!==Number(companyId))throw Object.assign(new Error(
        'The selected payment company is a different company than this project. Choose the matching company or project.'),{status:400});
      companyId=project.companyId;
    }
    companyId ||= fuelFloat?.companyId||null;
    const [[company]]=companyId?await connection.execute('SELECT id FROM companies WHERE id=? AND active=1',[companyId]):[[null]];
    if(!company)throw Object.assign(new Error('Choose an active operating company.'),{status:400});
    const [result]=await connection.execute(`INSERT INTO fuel_records
      (vehicle_id,company_id,project_id,fuel_date,litres,cost,odometer,driver,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [vehicle.id,companyId,projectId,body.fuelDate,body.litres??null,body.cost,body.odometer,body.driver||vehicle.driver,userId]);
    if(fuelFloat)await connection.execute(`INSERT INTO petty_cash_entries
      (float_id,kind,amount,entry_date,description,category,project_id,fuel_record_id,payee,recorded_by,company_id)
      VALUES (?,'Spend',?,?,?,'Fuel',?,?,?,?,?)`,
      [fuelFloat.id,-body.cost,body.fuelDate,`Fuel — ${vehicle.vehicle} (${vehicle.registration})`,projectId,result.insertId,body.vendor||null,userId,companyId]);
    await connection.execute('UPDATE fleet SET odometer=GREATEST(odometer,?) WHERE id=?',[body.odometer,vehicle.id]);
    await connection.execute(`INSERT INTO vehicle_odometer_readings
      (vehicle_id,company_id,project_id,reading_date,odometer,source,source_id,recorded_by) VALUES (?,?,?,?,?,'Fuel',?,?)`,
      [vehicle.id,companyId,projectId,body.fuelDate,body.odometer,result.insertId,userId]);
    if(projectId)await connection.execute(`INSERT INTO expenses
      (project_id,source,description,amount,expense_date,origin_type,origin_id,created_by)
      VALUES (?,'Fuel',?,?,?,'fuel_record',?,?)`,
      [projectId,`Fuel — ${vehicle.vehicle} (${vehicle.registration})`,body.cost,body.fuelDate,String(result.insertId),userId]);
    await audit(connection,userId,'CREATE','fuel_record',result.insertId,null,{...body,projectId},ip);
    return result.insertId;
}
