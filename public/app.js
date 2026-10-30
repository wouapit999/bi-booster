const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>[...r.querySelectorAll(s)];
const API='/api';
const DOMAIN='@bouquet-innovation.net';
const platforms={
  tiktok:{label:'TikTok',icon:'♪',className:'platform-tiktok'},
  instagram:{label:'Instagram',icon:'◎',className:'platform-instagram'},
  facebook:{label:'Facebook',icon:'f',className:'platform-facebook'},
  linkedin:{label:'LinkedIn',icon:'in',className:'platform-linkedin'},
  x:{label:'X',icon:'𝕏',className:'platform-tiktok'},
  youtube:{label:'YouTube',icon:'▶',className:'platform-facebook'},
  threads:{label:'Threads',icon:'@',className:'platform-instagram'}
};
const views={
  overview:['Overview','Your portfolio, ready for its next move.'],
  planner:['Content planner','Draft and organize posts across every client.'],
  inbox:['Engagement inbox','Connect social channels to manage conversations here.'],
  analytics:['Analytics','Performance summaries use data saved from connected channels.'],
  studio:['AI studio','Configure an AI provider to generate client-ready content.'],
  settings:['Workspace settings','Manage your workspace, team access, and connected channels.']
};
let state={user:null,clients:[],posts:[],tasks:[],series:[],byPlatform:[],selectedClient:'all'};
let toastTimeout;

function toast(message){
  const item=$('#toast');item.textContent=message;item.classList.add('show');
  clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>item.classList.remove('show'),3000);
}
function formError(selector,message){const item=$(selector);item.textContent=message;item.hidden=false;}
function clearError(selector){const item=$(selector);item.textContent='';item.hidden=true;}
async function api(path,options={}){
  const headers=new Headers(options.headers||{});
  if(options.body&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  const response=await fetch(API+path,{...options,headers,credentials:'same-origin',cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    if(response.status===401){state={user:null,clients:[],posts:[],tasks:[],series:[],byPlatform:[],selectedClient:'all'};showLogin();}
    throw new Error(data.error||'The request could not be completed.');
  }
  return data;
}
function showLogin(){
  document.body.classList.remove('authenticated');$('#auth-screen').hidden=false;
  $('#login-entry').hidden=false;$('#login-sent').hidden=true;$('#login-verifying').hidden=true;
}
function showWorkspace(user){
  state.user=user;document.body.classList.add('authenticated');$('#auth-screen').hidden=true;
  $('#profile-email').textContent=user.email;
  $('#profile-avatar').textContent=user.email.split('@')[0].slice(0,2).toUpperCase();
  $('#profile-role').textContent={admin:'Workspace admin',manager:'Manager',editor:'Editor',viewer:'Viewer'}[user.role]||'Bouquet Innovation';
  $('.add-client').hidden=user.role!=='admin';
}
function element(tag,className,text){
  const item=document.createElement(tag);
  if(className)item.className=className;
  if(text!==undefined)item.textContent=String(text);
  return item;
}
function compact(value){
  return new Intl.NumberFormat('en',{maximumFractionDigits:1,notation:Number(value||0)>=10000?'compact':'standard'}).format(Number(value||0));
}
function dateLabel(value){
  if(!value)return 'No date';
  const date=new Date(String(value).length===10?String(value)+'T00:00:00':value);
  if(Number.isNaN(date.getTime()))return 'No date';
  return new Intl.DateTimeFormat('en',{month:'short',day:'numeric'}).format(date);
}
function iconFor(name,small=true){
  const meta=platforms[name]||{label:name,icon:'•',className:'platform-tiktok'};
  const icon=element('span',(small?'platform-small ':'platform-icon ')+meta.className,meta.icon);
  icon.title=meta.label;icon.setAttribute('aria-label',meta.label);return icon;
}
function setMetric(selector,value,note){
  $(selector).textContent=value;
  const noteSelector=selector+'-note';
  if($(noteSelector))$(noteSelector).textContent=note;
}
function renderClients(){
  const list=$('#client-list');list.replaceChildren();
  const all=element('button','client-item'+(state.selectedClient==='all'?' selected':''));
  all.type='button';all.dataset.client='all';
  all.append(element('span','client-logo logo-luma','BI'),element('span','', 'All clients'));
  all.addEventListener('click',()=>selectClient('all'));list.append(all);
  for(const client of state.clients){
    const button=element('button','client-item'+(state.selectedClient===client.id?' selected':''));
    button.type='button';button.dataset.client=client.id;
    button.append(element('span','client-logo logo-terra',client.name.trim().slice(0,1).toUpperCase()),element('span','',client.name));
    if(Number(client.connected_platforms)>0){
      const dot=element('span','client-presence');dot.setAttribute('aria-label',Number(client.connected_platforms)+' connected channels');button.append(dot);
    }
    button.addEventListener('click',()=>selectClient(client.id));list.append(button);
  }
  const select=$('#client-select');const current=select.value;select.replaceChildren(new Option('Select a client',''));
  for(const client of state.clients)select.add(new Option(client.name,client.id));
  if(state.clients.some((client)=>client.id===current))select.value=current;
  const connected=state.clients.reduce((total,client)=>total+Number(client.connected_platforms||0),0);
  $('#connection-status').lastChild.textContent=connected?connected+' channels connected':'Neon connected';
  const notice=$('#workspace-notice');notice.replaceChildren();
  notice.append(element('span','', 'DATABASE CONNECTED'));
  notice.append(element('p','',connected?'Workspace data is live. Social publishing needs official channel authorization.':'Workspace data is live. Connect a social account to collect performance.'));
  $('#welcome-sub').textContent=state.clients.length
    ?state.clients.length+' client '+(state.clients.length===1?'account':'accounts')+' in your portfolio. Here is what to focus on today.'
    :'Add your first client to start building the portfolio.';
}
function selectClient(id){
  state.selectedClient=id;renderClients();renderPosts();renderTasks();window.onClientSelected?.();
  const client=state.clients.find((item)=>item.id===id);
  $('#welcome-sub').textContent=id==='all'
    ?state.clients.length+' client accounts in your portfolio. Here is what to focus on today.'
    :'Viewing '+(client?.name||'client')+' within the portfolio.';
}
function renderStats(stats){
  setMetric('#metric-reach',compact(stats.reach),'Last 30 days · connected accounts');
  setMetric('#metric-engagement',Number(stats.engagementRate||0).toFixed(2)+'%','Engagements ÷ impressions · 30 days');
  setMetric('#metric-followers',(Number(stats.followersGained||0)>0?'+':'')+compact(stats.followersGained),'Last 30 days · connected accounts');
  setMetric('#metric-posts',compact(stats.plannerPosts),'Drafts and scheduled posts');
}
function renderPosts(){
  const list=$('#post-list');list.replaceChildren();
  const posts=state.selectedClient==='all'?state.posts:state.posts.filter((post)=>post.client_id===state.selectedClient);
  if(!posts.length){list.append(element('p','empty-inline',state.selectedClient==='all'?'No drafts yet. Create a post to start the planner.':'No posts for this client yet.'));return;}
  posts.forEach((post,index)=>{
    const article=element('article','post-item');
    const rail=element('div','post-rail');rail.append(element('span','post-dot'+(post.status==='scheduled'?' dot-live':'')));
    if(index<posts.length-1)rail.append(element('i'));
    const body=element('div','post-body');const meta=element('div','post-meta');
    meta.append(element('span','',post.scheduled_at?dateLabel(post.scheduled_at):'Draft'));
    (post.platforms||[]).slice(0,3).forEach((platform)=>meta.append(iconFor(platform)));
    meta.append(element('span','',post.client_name));
    meta.append(element('span','post-status status-'+post.status,post.status[0].toUpperCase()+post.status.slice(1)));
    body.append(meta,element('p','',post.content||'No caption added yet.'));article.append(rail,body);
    article.tabIndex=0;article.setAttribute('role','button');article.style.cursor='pointer';
    article.addEventListener('click',()=>window.openPost?.(post.id));
    article.addEventListener('keydown',(event)=>{if(event.key==='Enter')window.openPost?.(post.id);});
    list.append(article);
  });
}
function renderTasks(){
  const list=$('#task-list');list.replaceChildren();
  const tasks=state.selectedClient==='all'?state.tasks:state.tasks.filter((task)=>!task.client_id||task.client_id===state.selectedClient);
  if(!tasks.length){list.append(element('p','empty-inline','No open tasks. Add a next step for the team.'));return;}
  for(const task of tasks){
    const row=element('div','task-item');
    const check=element('button','task-check');check.type='button';check.setAttribute('aria-label','Mark '+task.title+' complete');
    check.addEventListener('click',async()=>{
      check.disabled=true;
      try{await api('/tasks/'+task.id,{method:'PATCH',body:JSON.stringify({status:'done'})});await loadDashboard();toast('Task marked complete.');}
      catch(error){check.disabled=false;toast(error.message);}
    });
    row.append(check,element('span','task-text',task.title));
    row.append(element('span','task-owner',(task.assigned_email||state.user.email).split('@')[0].slice(0,2).toUpperCase()));
    row.append(element('span','task-time',dateLabel(task.due_on)));list.append(row);
  }
}
function linePath(values,mapY){
  return values.map((value,index)=>{
    const x=values.length<2?340:index*680/(values.length-1);
    return (index?'L':'M')+x.toFixed(1)+' '+mapY(Number(value||0)).toFixed(1);
  }).join(' ');
}
function renderChart(series){
  const reach=series.map((item)=>Number(item.reach||0));const max=Math.max(...reach,0);
  $('#chart-empty').hidden=max>0;
  if(!max){
    $('#reach-line').setAttribute('d','');$('#chart-fill').setAttribute('d','');$('#engagement-line').setAttribute('d','');
    $('#chart-y-labels').replaceChildren(element('span','—'),element('span','—'),element('span','—'),element('span','0'));return;
  }
  const top=max*1.15;const y=(value)=>210-Number(value)/top*184;const path=linePath(reach,y);
  $('#reach-line').setAttribute('d',path);$('#chart-fill').setAttribute('d',path+' L680 230 L0 230 Z');
  $('#engagement-line').setAttribute('d',linePath(series.map((item)=>item.engagement_rate),(value)=>210-Math.min(value,20)/20*120));
  $('#chart-y-labels').replaceChildren(element('span','',compact(top)),element('span','',compact(top*2/3)),element('span','',compact(top/3)),element('span','0'));
  const labels=$('#chart-x-labels');labels.replaceChildren(element('span','',series[0]?.metric_date||'Earlier'),element('span','',series.at(-1)?.metric_date||'Today'));
}
function renderPlatforms(items){
  const list=$('#channel-rows');list.replaceChildren();
  if(!items.length){list.append(element('p','empty-inline','Channel performance appears after accounts are connected.'));return;}
  const max=Math.max(...items.map((item)=>Number(item.reach||0)),1);
  for(const item of items){
    const meta=platforms[item.platform]||{label:item.platform,icon:'•',className:'platform-tiktok'};
    const row=element('div','channel-row');row.append(iconFor(item.platform,false),element('span','channel-name',meta.label));
    const bar=element('span','channel-bar');const fill=element('i');fill.style.width=Math.max(3,Number(item.reach||0)/max*100)+'%';bar.append(fill);
    row.append(bar,element('b','',compact(item.reach)),element('span','channel-period','reach'));list.append(row);
  }
}
function renderDashboard(data){
  state.user=data.user||state.user;state.clients=data.clients||[];state.posts=data.posts||[];
  state.tasks=data.tasks||[];state.series=data.series||[];state.byPlatform=data.byPlatform||[];
  renderStats(data.stats||{});renderClients();renderPosts();renderTasks();renderChart(state.series);renderPlatforms(state.byPlatform);
  const today=new Date();
  $('#queue-date-day').textContent=new Intl.DateTimeFormat('en',{day:'2-digit'}).format(today);
  $('#queue-date-month').textContent=new Intl.DateTimeFormat('en',{month:'short'}).format(today).toUpperCase();
  $('#queue-post-count').textContent=state.posts.length+' planner '+(state.posts.length===1?'item':'items')+' · '+state.tasks.length+' open tasks';
  $('#profile-email').textContent=state.user.email;
  window.onDashboard?.(data);
}
async function loadDashboard(){
  try{renderDashboard(await api('/dashboard'));}
  catch(error){if(document.body.classList.contains('authenticated'))toast(error.message);}
}
function openDialog(selector){const dialog=$(selector);if(dialog&&!dialog.open)dialog.showModal();}
function closeDialog(selector){const dialog=$(selector);if(dialog?.open)dialog.close();}
function setBusy(button,busy,label){
  if(busy){button.dataset.originalText=button.textContent;button.disabled=true;button.textContent=label;}
  else{button.disabled=false;button.textContent=button.dataset.originalText||button.textContent;delete button.dataset.originalText;}
}
async function submitLogin(event){
  event.preventDefault();clearError('#login-error');
  const email=$('#login-email').value.trim().toLowerCase();
  if(!email.endsWith(DOMAIN)){formError('#login-error','Sign-in is limited to '+DOMAIN+' email addresses.');return;}
  const button=$('#login-submit');setBusy(button,true,'Sending link…');
  try{
    const response=await fetch(API+'/auth/request',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({email})});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(result.error||'We could not send your sign-in link.');
    $('#sent-email').textContent=email;$('#login-entry').hidden=true;$('#login-sent').hidden=false;
  }catch(error){formError('#login-error',error.message||'Sign-in is temporarily unavailable.');}
  finally{setBusy(button,false);}
}
async function completeMagicLink(token){
  $('#auth-screen').hidden=false;$('#login-entry').hidden=true;$('#login-sent').hidden=true;$('#login-verifying').hidden=false;
  try{
    const response=await fetch(API+'/auth/verify',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',body:JSON.stringify({token})});
    const result=await response.json().catch(()=>({}));history.replaceState(null,'',location.pathname+location.search);
    if(!response.ok)throw new Error(result.error||'This sign-in link is invalid or has expired.');
    showWorkspace(result.user);await loadDashboard();await window.onWorkspaceReady?.();
  }catch(error){$('#login-verifying').hidden=true;$('#login-entry').hidden=false;formError('#login-error',error.message||'This sign-in link is invalid or has expired.');}
}
async function signOut(){
  try{await fetch(API+'/auth/logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'});}catch{}
  state={user:null,clients:[],posts:[],tasks:[],series:[],byPlatform:[],selectedClient:'all'};
  showLogin();toast('You have signed out.');
}
async function initialize(){
  $('#today-label').textContent=new Intl.DateTimeFormat('en',{weekday:'long',month:'long',day:'numeric'}).format(new Date()).toUpperCase();
  $('#login-form').addEventListener('submit',submitLogin);
  $('#change-email').addEventListener('click',()=>{$('#login-sent').hidden=true;$('#login-entry').hidden=false;$('#login-email').focus();});
  $('#logout-button').addEventListener('click',signOut);
  $('#compose-btn').addEventListener('click',()=>window.openCompose?.());
  $('#alt-compose').addEventListener('click',()=>window.openCompose?.());
  $('#assist-btn').addEventListener('click',()=>{
    const field=$('#post-copy');const intro=field.value.trim();
    field.value=intro?intro+'\n\nStarter prompt: show a small detail your audience would notice first, then tell them why it matters.':'Starter prompt: what small moment does your product make better?';
    toast('Added a writing prompt. Configure an AI provider for generated copy.');
  });
  $('.add-client').addEventListener('click',()=>openDialog('#client-dialog'));
  $('#client-form').addEventListener('submit',async(event)=>{
    event.preventDefault();clearError('#client-error');const button=$('#client-form button[type=submit]');setBusy(button,true,'Adding…');
    try{await api('/clients',{method:'POST',body:JSON.stringify({name:$('#client-name').value,industry:$('#client-industry').value})});closeDialog('#client-dialog');$('#client-form').reset();await loadDashboard();toast('Client added to the portfolio.');}
    catch(error){formError('#client-error',error.message);}
    finally{setBusy(button,false);}
  });
  $('#task-add').addEventListener('click',()=>openDialog('#task-dialog'));
  $('#task-form').addEventListener('submit',async(event)=>{
    event.preventDefault();clearError('#task-error');const button=$('#task-form button[type=submit]');setBusy(button,true,'Adding…');
    try{await api('/tasks',{method:'POST',body:JSON.stringify({title:$('#task-title').value,dueOn:$('#task-due').value||null,assignedTo:$('#task-assignee').value||null,clientId:$('#task-client').value||null})});closeDialog('#task-dialog');$('#task-form').reset();await loadDashboard();toast('Task added to team focus.');}
    catch(error){formError('#task-error',error.message);}
    finally{setBusy(button,false);}
  });
  $$('[data-close-dialog]').forEach((button)=>button.addEventListener('click',()=>closeDialog('#'+button.dataset.closeDialog)));
  $('#report-btn').addEventListener('click',()=>toast('Reports will be available after channel analytics are connected.'));
  $$('[data-view]').forEach((item)=>item.addEventListener('click',(event)=>{
    event.preventDefault();const view=item.dataset.view;if(!views[view])return;
    $$('.nav-item[data-view]').forEach((nav)=>nav.classList.toggle('active',nav.dataset.view===view));
    $('#crumb-current').textContent=views[view][0];const home=view==='overview';
    $('#overview-view').hidden=!home;$('#alternate-view').hidden=home;
    if(!home){$('#alt-title').textContent=views[view][0];$('#alt-copy').textContent=views[view][1];$('#alt-placeholder').replaceChildren();window.renderManageView?.(view);}
    history.replaceState(null,'',location.pathname+location.search+'#'+view);
  }));
  $('#back-overview').addEventListener('click',()=>{location.hash='overview';$('[data-view=\"overview\"]').click();});
  $$('.chart-toggle button').forEach((button)=>button.addEventListener('click',()=>{
    button.parentElement.querySelector('.toggle-active')?.classList.remove('toggle-active');button.classList.add('toggle-active');
    toast('The portfolio chart currently shows the last 30 days.');
  }));
  const token=new URLSearchParams(location.hash.slice(1)).get('login_token');
  if(token){await completeMagicLink(token);return;}
  try{
    const response=await fetch(API+'/auth/me',{credentials:'same-origin',cache:'no-store'});
    if(!response.ok){showLogin();return;}
    const data=await response.json();showWorkspace(data.user);await loadDashboard();await window.onWorkspaceReady?.();
  }catch{showLogin();}
}
initialize();
