import React,{useEffect,useState} from 'react';
import {Fuel,Gauge,Wrench} from 'lucide-react';
import {api,rupees} from '../api.js';
import {Row,Summary,Table} from '../ui.jsx';

export default function VehicleExpenseReport({companyId,company}){
  const [period,setPeriod]=useState(()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Colombo',year:'numeric',month:'2-digit'}).format(new Date())),[report,setReport]=useState(null),[error,setError]=useState('');
  useEffect(()=>{setReport(null);api(`/fleet/monthly-report?companyId=${companyId}&period=${period}`).then(value=>{setReport(value);setError('');}).catch(failure=>setError(failure.message));},[companyId,period]);
  const template='minmax(170px,1.2fr) minmax(150px,1fr) 90px 120px 110px 110px 100px 120px';
  return <section className="workspace-surface"><div className="workspace-section-heading"><div><span className="section-kicker">{report?.company?.name||company?.name}</span><h2>Monthly vehicle and fuel expenses</h2><p>Vehicles are shared. This report contains only costs incurred by the selected company.</p></div><label>Reporting month<input type="month" value={period} onChange={event=>setPeriod(event.target.value)}/></label></div>
    {error&&<p className="form-error">{error}</p>}{report&&<><div className="attendance-summary"><Summary label="Fuel used" value={`${Number(report.totals.fuelLitres).toLocaleString('en-LK')} L`} icon={Fuel}/><Summary label="Fuel cost" value={rupees(report.totals.fuelCost)} icon={Fuel}/><Summary label="Repairs & service" value={rupees(Number(report.totals.repairCost)+Number(report.totals.serviceCost)+Number(report.totals.inspectionCost))} icon={Wrench}/><Summary label="Cost per kilometre" value={report.totals.costPerKm===null?'Need two readings':rupees(report.totals.costPerKm)} icon={Gauge}/></div>
      <Table columns={['Vehicle','Project / cost centre','Litres','Fuel','Repairs','Service','Distance','Cost / km']} template={template} title={`${period} operating cost`} empty="No attributed fuel, repair or service costs were recorded for this company and month.">{report.rows.map(row=><Row template={template} key={`${row.vehicleId}-${row.projectId||0}`}><div><strong>{row.vehicle}</strong><small>{row.registration}</small></div><span>{row.project}</span><span>{Number(row.fuelLitres).toLocaleString('en-LK')}</span><span>{rupees(row.fuelCost)}</span><span>{rupees(row.repairCost)}</span><span>{rupees(Number(row.serviceCost)+Number(row.inspectionCost))}</span><span>{Number(row.distanceKm).toLocaleString('en-LK')} km</span><strong>{row.costPerKm===null?'—':rupees(row.costPerKm)}</strong></Row>)}</Table></>}
  </section>;
}
