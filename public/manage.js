// Team access, social connections, the planner approval workflow and the composer.
// Loaded after app.js and reuses its helpers ($, api, element, toast, state…).
const ADMIN_ADDRESS='support@bouquet-innovation.net';
const ROLE_INFO={
  admin:['Admin','Manages the team, clients and social connections. Approves and publishes for every client.'],
  manager:['Manager','Approves, schedules and publishes posts for the clients they are assigned to.'],
  editor:['Editor','Writes drafts for assigned clients and submits them for approval.'],
  viewer:['Viewer','Read-only access to assigned clients, their posts and results.']
};
const STATUS_LABELS={draft:'Draft',review:'Needs approval',changes_requested:'Changes requested',approved:'Approved',scheduled:'Scheduled',publishing:'Publishing',published:'Published',partial:'Partly published',failed:'Failed',pending:'Waiting',processing:'Processing',connected:'Connected',expired:'Reconnect needed',error:'Error',invited:'Invited',active:'Active',disabled:'Deactivated'};
const PLANNER_TABS=[['all','All'],['needs_approval','Needs approval'],['drafts','Drafts'],['scheduled','Scheduled'],['published','Published'],['failed','Failed']];
const CONNECT_HELP={
  facebook:'Pages you manage. Text, photos, albums and videos.',
  instagram:'Business or Creator accounts linked to a Facebook Page. Photos, carousels and Reels.',
  tiktok:'Creator accounts. Videos and photo posts.',
  youtube:'Channels on a Google account. Video uploads.'
};
const ACTIVITY_TEXT={'post.created':'Created the post','post.edited':'Edited the post','post.submitted':'Submitted for approval','post.approved':'Approved the post','post.changes_requested':'Requested changes','post.unscheduled':'Took the post off the schedule','post.publish_now':'Started publishing now','post.retry':'Retried the failed accounts','post.published':'Published to every account','post.partial':'Published to some accounts','post.failed':'Publishing failed','post.comment':'Commented'};
const ACTION_DONE={submit:'Sent for approval.',approve:'Post approved.',request_changes:'Sent back with your notes.',schedule:'Post scheduled.',unschedule:'Post taken off the schedule.',publish_now:'Publishing started.',retry:'Retrying the failed accounts.',comment:'Comment added.'};
const COMPOSE_DONE={draft:'Draft saved.',submit:'Sent for approval.',schedule:'Post scheduled.',publish_now:'Publishing started.'};
const mgr={config:null,accounts:[],team:[],posts:[],group:'all',settingsClient:'',oauthError:'',editingMember:null,openPostId:null,compose:{postId:null,status:'draft',media:[]}};

const roleOf=()=>state.user?.role||'viewer';
const isAdminUser=()=>roleOf()==='admin';
const canApproveUser=()=>['admin','manager'].includes(roleOf());
const canEditUser=()=>roleOf()!=='viewer';
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pill(status,text){return element('span','pill pill-'+status,text||STATUS_LABELS[status]||status);}
function fmtDateTime(value){
  if(!value)return 'Not scheduled';const date=new Date(value);if(Number.isNaN(date.getTime()))return 'Not scheduled';
  return new Intl.DateTimeFormat('en',{weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(date);
}
function toLocalInput(value){if(!value)return '';const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
function fromLocalInput(value){return value?new Date(value).toISOString():null;}
function actionButton(label,className,handler){const item=element('button','button '+(className||'button-quiet'),label);item.type='button';if(handler)item.addEventListener('click',handler);return item;}
function linkButton(label,className,href,external){const item=element('a','button '+className,label);item.href=href;if(external){item.target='_blank';item.rel='noopener noreferrer';}return item;}
function note(text,ok){return element('p','manage-note'+(ok?' ok':''),text);}
function section(title,description,aside){
  const box=element('section','manage-section');const header=element('header');const copy=element('div');
  copy.append(element('h2','',title));if(description)copy.append(element('p','',description));header.append(copy);if(aside)header.append(aside);box.append(header);return box;
}
function avatar(account){
  if(/^https:\/\//.test(account.avatar_url||'')){const img=element('img','account-avatar');img.src=account.avatar_url;img.alt='';img.referrerPolicy='no-referrer';return img;}
  return element('span','account-avatar',(account.display_name||'?').replace('@','').slice(0,1).toUpperCase());
}
function currentView(){return $('.nav-item.active[data-view]')?.dataset.view||'overview';}

async function loadConfig(){try{mgr.config=await api('/config');}catch{mgr.config=null;}}
async function loadAccounts(){try{mgr.accounts=(await api('/accounts')).accounts||[];}catch{mgr.accounts=[];}}
async function loadTeam(){try{mgr.team=(await api('/team')).members||[];}catch{mgr.team=[];}}
async function refreshAfterChange(){
  await loadDashboard();
  if(currentView()==='planner')renderPlanner();
}

// ---------- Planner ----------

async function renderPlanner(){
  const host=$('#alt-placeholder');host.classList.add('manage-host');host.replaceChildren(element('p','empty-inline','Loading posts…'));
  const params=new URLSearchParams();if(mgr.group!=='all')params.set('group',mgr.group);
  if(state.selectedClient&&state.selectedClient!=='all')params.set('clientId',state.selectedClient);
  try{mgr.posts=(await api('/posts?'+params)).posts||[];}catch(error){host.replaceChildren(element('p','empty-inline',error.message));return;}
  const counts=state.counts||{};const tabs=element('div','planner-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Planner filters');
  for(const [key,label] of PLANNER_TABS){
    const tab=element('button',key===mgr.group?'active':'',label);tab.type='button';tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(key===mgr.group));
    if(key==='needs_approval'&&counts.review)tab.append(element('i','',counts.review));
    if(key==='failed'&&counts.failed)tab.append(element('i','',counts.failed));
    tab.addEventListener('click',()=>{mgr.group=key;renderPlanner();});tabs.append(tab);
  }
  const list=element('div');
  if(!mgr.posts.length){
    const empty={needs_approval:'Nothing is waiting for approval.',failed:'No failed posts. Nice.',published:'Nothing published yet.',scheduled:'Nothing is scheduled yet.'}[mgr.group];
    list.append(element('p','empty-inline',empty||'No posts here yet. Create a post to start planning.'));
  }
  let lastDay='';
  for(const post of mgr.posts){
    const when=post.scheduled_at||post.published_at||post.created_at;
    const day=new Intl.DateTimeFormat('en',{weekday:'long',month:'long',day:'numeric'}).format(new Date(when));
    if(day!==lastDay){list.append(element('h3','planner-day',day));lastDay=day;}
    const row=element('button','planner-row');row.type='button';
    const timed=post.published_at||post.scheduled_at;
    const time=element('div','planner-time',timed?new Intl.DateTimeFormat('en',{hour:'2-digit',minute:'2-digit'}).format(new Date(when)):'—');
    time.append(element('small','',post.published_at?'published':post.scheduled_at?'planned':'no time yet'));
    const copy=element('div','planner-copy');copy.append(element('p','',post.title||post.content||'No caption yet'));
    const meta=element('div','planner-meta');(post.targets||[]).forEach((target)=>meta.append(iconFor(target.platform)));
    meta.append(element('span','',post.client_name+' · by '+String(post.author_email||'').split('@')[0]));
    if((post.media||[]).length)meta.append(element('span','','· '+post.media.length+' media'));
    copy.append(meta);row.append(time,copy,pill(post.status));row.addEventListener('click',()=>openPost(post.id));list.append(row);
  }
  host.replaceChildren(tabs,list);
}

// ---------- Post detail and workflow actions ----------

async function openPost(id){
  mgr.openPostId=id;const body=$('#post-dialog-body');body.replaceChildren(element('p','empty-inline','Loading the post…'));openDialog('#post-dialog');
  try{renderPostDetail(await api('/posts/'+id));}catch(error){body.replaceChildren(element('p','auth-error',error.message));}
}
function mediaThumbs(media,removable){
  const wrap=element('div','media-thumbs');
  media.forEach((item,index)=>{
    const thumb=element(removable?'div':'a','media-thumb');
    if(!removable){thumb.href=item.url;thumb.target='_blank';thumb.rel='noopener noreferrer';thumb.title=item.name||item.url;}
    if(item.type==='image'){const img=element('img');img.src=item.url;img.alt=item.name||'Image';img.loading='lazy';img.referrerPolicy='no-referrer';thumb.append(img);}
    else thumb.append(element('span','','▶ '+String(item.name||'Video').slice(0,22)));
    if(removable){
      const remove=element('button','','×');remove.type='button';remove.setAttribute('aria-label','Remove '+(item.name||'media'));
      remove.addEventListener('click',()=>{mgr.compose.media.splice(index,1);renderComposeMedia();});thumb.append(remove);
    }
    wrap.append(thumb);
  });
  return wrap;
}
function describeActivity(item){
  if(item.action==='post.scheduled')return 'Scheduled for '+fmtDateTime(item.detail);
  return ACTIVITY_TEXT[item.action]||item.action;
}
function renderPostDetail({post,targets,activity}){
  if(mgr.openPostId!==post.id)return;
  const body=$('#post-dialog-body');const top=element('div','dialog-top');const head=element('div');
  head.append(element('span','dialog-kicker',String(post.client_name||'').toUpperCase()+' · POST'));
  const title=element('h2','',STATUS_LABELS[post.status]||post.status);title.id='post-dialog-title';head.append(title);
  const close=element('button','dialog-close','×');close.type='button';close.setAttribute('aria-label','Close post');close.addEventListener('click',()=>closeDialog('#post-dialog'));
  top.append(head,close);const parts=[top];
  if(post.title)parts.push(element('p','detail-title',post.title));
  parts.push(element('div','detail-copy',post.content||'No caption.'));
  if((post.media||[]).length)parts.push(mediaThumbs(post.media,false));
  const grid=element('dl','detail-grid');const add=(key,value)=>grid.append(element('dt','',key),element('dd','',value));
  add('Author',post.author_email);add('Publish time',fmtDateTime(post.scheduled_at));
  if(post.published_at)add('Published',fmtDateTime(post.published_at));
  const targetPlatforms=new Set(targets.map((target)=>target.platform));
  if(targetPlatforms.has('tiktok')&&post.options?.tiktokPrivacy)add('TikTok visibility',post.options.tiktokPrivacy.replaceAll('_',' ').toLowerCase());
  if(targetPlatforms.has('youtube')&&post.options?.youtubePrivacy)add('YouTube visibility',post.options.youtubePrivacy);
  parts.push(grid);
  const targetList=element('div','target-list');
  if(!targets.length)targetList.append(element('p','empty-inline','No social accounts chosen yet. Edit the post to pick them.'));
  for(const target of targets){
    const row=element('div','target-row');row.append(iconFor(target.platform));
    const name=element('div');name.append(element('span','',target.display_name));if(target.error)name.append(element('span','target-error',target.error));row.append(name);
    if(target.external_url&&/^https:\/\//.test(target.external_url))row.append(linkButton('View ↗','button-quiet button-small',target.external_url,true));
    const disconnected=target.account_status!=='connected'&&target.status!=='published';
    row.append(disconnected?pill('expired','Reconnect account'):pill(target.status));targetList.append(row);
  }
  parts.push(targetList,postActions(post,targets));
  const log=element('ul','activity-list');
  for(const item of activity){
    const li=element('li','',describeActivity(item));
    li.append(element('small','',(item.user_email||'BI Booster')+' · '+fmtDateTime(item.created_at)));
    if(item.detail&&item.action!=='post.scheduled')li.append(element('q','',item.detail));log.append(li);
  }
  const commentRow=element('div','comment-row');const input=element('input');input.placeholder='Add a comment for the team…';input.maxLength=1000;input.setAttribute('aria-label','Comment');
  commentRow.append(input,actionButton('Comment','button-quiet button-small',()=>{if(input.value.trim())doAction(post.id,'comment',{note:input.value});}));
  parts.push(element('h3','planner-day','Activity & comments'),log,commentRow);
  body.replaceChildren(...parts);
  if(post.status==='publishing')setTimeout(async()=>{
    if(!$('#post-dialog').open||mgr.openPostId!==post.id)return;
    try{renderPostDetail(await api('/posts/'+post.id));await refreshAfterChange();}catch{}
  },7000);
}
function postActions(post,targets){
  const wrap=element('div');const row=element('div','detail-actions');const status=post.status;
  const mine=post.author_id===state.user.id;const approver=canApproveUser();
  const editable=approver?['draft','review','changes_requested','approved','scheduled','failed','partial'].includes(status):canEditUser()&&['draft','changes_requested'].includes(status);
  if(editable)row.append(actionButton('Edit','button-quiet',()=>{closeDialog('#post-dialog');openCompose({...post,targets:targets.map((target)=>({accountId:target.account_id}))});}));
  if(canEditUser()&&['draft','changes_requested'].includes(status))row.append(actionButton('Submit for approval',approver?'button-quiet':'button-primary',()=>doAction(post.id,'submit')));
  if(approver&&status==='review'){
    row.append(actionButton('Approve','button-primary',()=>doAction(post.id,'approve')));
    row.append(actionButton('Request changes','button-quiet',()=>{
      if(wrap.querySelector('.changes-row'))return;
      const box=element('div','comment-row changes-row');const field=element('input');field.placeholder='What needs to change?';field.maxLength=1000;field.setAttribute('aria-label','Requested changes');
      box.append(field,actionButton('Send back','button-primary button-small',()=>{if(!field.value.trim()){field.focus();return;}doAction(post.id,'request_changes',{note:field.value});}));
      wrap.append(box);field.focus();
    }));
  }
  const deletable=(approver&&status!=='publishing')||(canEditUser()&&mine&&['draft','changes_requested'].includes(status));
  if(deletable)row.append(actionButton('Delete','button-danger',async()=>{
    if(!confirm('Delete this post from the planner? Anything already published stays on the social platforms.'))return;
    try{await api('/posts/'+post.id,{method:'DELETE'});closeDialog('#post-dialog');toast('Post deleted.');await refreshAfterChange();}catch(error){toast(error.message);}
  }));
  wrap.append(row);
  if(approver&&['draft','review','changes_requested','approved','scheduled','failed','partial'].includes(status)){
    const schedule=element('div','detail-schedule');const when=element('input');when.type='datetime-local';when.setAttribute('aria-label','Publish time');
    if(post.scheduled_at&&Date.parse(post.scheduled_at)>Date.now())when.value=toLocalInput(post.scheduled_at);
    schedule.append(when,actionButton(status==='scheduled'?'Reschedule':'Schedule','button-quiet',()=>{
      if(!when.value){toast('Choose a publish time first.');when.focus();return;}
      doAction(post.id,'schedule',{scheduledAt:fromLocalInput(when.value)});
    }));
    const retry=['failed','partial'].includes(status);
    schedule.append(actionButton(retry?'Retry failed accounts':'Publish now','button-primary',()=>{
      if(confirm(retry?'Try the failed accounts again now?':'Publish this post now to the selected accounts?'))doAction(post.id,retry?'retry':'publish_now');
    }));
    if(status==='scheduled')schedule.append(actionButton('Unschedule','button-quiet',()=>doAction(post.id,'unschedule')));
    wrap.append(schedule);
  }
  if(status==='publishing')wrap.append(element('p','form-note','Publishing is in progress. This view refreshes on its own.'));
  if(status==='review'&&!approver)wrap.append(element('p','form-note','Waiting for a manager to approve it.'));
  return wrap;
}
async function doAction(id,action,extra={}){
  try{
    await api('/posts/'+id+'/actions',{method:'POST',body:JSON.stringify({action,...extra})});toast(ACTION_DONE[action]||'Done.');
    await refreshAfterChange();if($('#post-dialog').open&&mgr.openPostId===id)renderPostDetail(await api('/posts/'+id));
  }catch(error){toast(error.message);}
}

// ---------- Composer ----------

function openCompose(post){
  if(!canEditUser()){toast('Viewers cannot create posts.');return;}
  const form=$('#compose-form');form.reset();clearError('#compose-error');
  mgr.compose={postId:post?.id||null,status:post?.status||'draft',media:[...(post?.media||[])]};
  $('#compose-kicker').textContent=post?'EDIT POST':'NEW CONTENT';
  $('#compose-title').textContent=post?'Refine it, then send it on.':'Make something that moves.';
  const select=$('#client-select');
  select.value=post?.client_id||(state.selectedClient&&state.selectedClient!=='all'?state.selectedClient:(state.clients.length===1?state.clients[0].id:''));
  select.disabled=Boolean(post);
  $('#post-copy').value=post?.content||'';$('#post-title').value=post?.title||'';
  $('#youtube-privacy').value=post?.options?.youtubePrivacy||'public';
  $('#tiktok-privacy').value=post?.options?.tiktokPrivacy||'PUBLIC_TO_EVERYONE';
  $('#post-schedule').value=post?.scheduled_at&&Date.parse(post.scheduled_at)>Date.now()?toLocalInput(post.scheduled_at):'';
  renderAccountPicks(post?(post.targets||[]).map((target)=>target.accountId||target.account_id):null);
  renderComposeMedia();updateCopyCount();updateComposeButtons();openDialog('#compose-dialog');
}
function selectedAccounts(){return $$('#account-picks input:checked');}
function renderAccountPicks(selected){
  const box=$('#account-picks');const clientId=$('#client-select').value;box.replaceChildren();
  if(!clientId){box.append(element('p','empty-inline','Choose a client to see its connected accounts.'));updatePlatformOptions();return;}
  const accounts=mgr.accounts.filter((account)=>account.client_id===clientId);
  if(!accounts.length)box.append(element('p','empty-inline',isAdminUser()?'No social accounts are connected for this client yet. Connect them in Settings.':'No social accounts are connected for this client yet. Ask the workspace admin to connect them.'));
  for(const account of accounts){
    const label=element('label');const input=element('input');input.type='checkbox';input.value=account.id;input.dataset.platform=account.platform;
    input.checked=selected?selected.includes(account.id):accounts.length===1;input.addEventListener('change',updatePlatformOptions);
    label.append(input,iconFor(account.platform),element('span','name',account.display_name));
    if(account.status!=='connected')label.append(pill('expired','Reconnect'));box.append(label);
  }
  updatePlatformOptions();
}
function updatePlatformOptions(){
  const chosen=new Set(selectedAccounts().map((input)=>input.dataset.platform));
  $('#youtube-options').hidden=!chosen.has('youtube');$('#tiktok-options').hidden=!chosen.has('tiktok');
  const notes=[];
  if(chosen.has('instagram'))notes.push('Instagram needs at least one JPEG image or a video.');
  if(chosen.has('tiktok'))notes.push('TikTok needs a video or images.');
  if(chosen.has('youtube'))notes.push('YouTube needs exactly one video and a title.');
  $('#compose-note').textContent=notes.join(' ');
}
function renderComposeMedia(){
  $('#media-list').replaceChildren(mediaThumbs(mgr.compose.media,true));
  const uploads=Boolean(mgr.config?.mediaUpload);$('#media-upload-btn').hidden=!uploads;
  $('#media-note').textContent=uploads
    ?'Upload images or videos (up to 95 MB each), or paste direct links. Up to 10 items.'
    :'Paste direct public links to images (.jpg) or videos (.mp4). File uploads switch on once Cloudflare R2 storage is enabled.';
}
function updateCopyCount(){const length=$('#post-copy').value.length;$('#copy-count').textContent=length.toLocaleString('en')+(length>2200?' — over the 2,200 limit for Instagram and TikTok':'');}
function updateComposeButtons(){
  const approver=canApproveUser();const status=mgr.compose.status;
  $('#submit-review-btn').hidden=!['draft','changes_requested'].includes(status);
  $('#submit-review-btn').className='button '+(approver?'button-quiet':'button-primary');
  $('#schedule-btn').hidden=!approver;$('#publish-now-btn').hidden=!approver;
  $('#save-draft-btn').textContent=mgr.compose.postId?'Save changes':'Save draft';
  $('#post-schedule-hint').textContent=approver?'':'Your approver sees this as the proposed time.';
}
async function uploadMediaFile(file){
  const clientId=$('#client-select').value;
  if(!clientId){formError('#compose-error','Choose a client before uploading media.');return;}
  if(mgr.compose.media.length>=10){formError('#compose-error','Attach at most 10 media items.');return;}
  const control=$('#media-upload-btn');setBusy(control,true,'Uploading…');
  try{
    const response=await fetch(API+'/media?'+new URLSearchParams({clientId,name:file.name}),{method:'POST',body:file,headers:{'Content-Type':file.type||'application/octet-stream'},credentials:'same-origin'});
    const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'The upload failed.');
    mgr.compose.media.push(data.media);renderComposeMedia();clearError('#compose-error');
  }catch(error){formError('#compose-error',error.message);}
  finally{setBusy(control,false);}
}
function addMediaUrl(){
  const url=$('#media-url').value.trim();
  if(!/^https:\/\/\S+$/.test(url)){formError('#compose-error','Paste a direct public link that starts with https://');return;}
  if(mgr.compose.media.length>=10){formError('#compose-error','Attach at most 10 media items.');return;}
  const type=$('#media-url-type').value;const name=url.split('/').pop().split('?')[0].slice(0,80);
  mgr.compose.media.push({url,type,name,mime:/\.jpe?g$/i.test(name)?'image/jpeg':''});
  $('#media-url').value='';clearError('#compose-error');renderComposeMedia();
}
async function saveCompose(action){
  clearError('#compose-error');const clientId=$('#client-select').value;
  if(!clientId){formError('#compose-error','Choose a client first.');return;}
  const scheduleValue=$('#post-schedule').value;
  if(action==='schedule'&&!scheduleValue){formError('#compose-error','Choose a publish time to schedule the post.');return;}
  if(action==='publish_now'&&!confirm('Publish this post now to the selected accounts?'))return;
  const payload={
    clientId,content:$('#post-copy').value,title:$('#post-title').value,media:mgr.compose.media,
    accountIds:selectedAccounts().map((input)=>input.value),scheduledAt:fromLocalInput(scheduleValue),
    options:{youtubePrivacy:$('#youtube-privacy').value,tiktokPrivacy:$('#tiktok-privacy').value}
  };
  const controls=$$('#compose-form .dialog-actions button');controls.forEach((control)=>{control.disabled=true;});
  try{
    let id=mgr.compose.postId;
    if(id)await api('/posts/'+id,{method:'PATCH',body:JSON.stringify(payload)});
    else{id=(await api('/posts',{method:'POST',body:JSON.stringify({...payload,action:'draft'})})).post.id;mgr.compose.postId=id;updateComposeButtons();}
    if(action!=='draft')await api('/posts/'+id+'/actions',{method:'POST',body:JSON.stringify({action,scheduledAt:payload.scheduledAt})});
    closeDialog('#compose-dialog');toast(COMPOSE_DONE[action]);await refreshAfterChange();
  }catch(error){
    formError('#compose-error',error.message+(mgr.compose.postId&&action!=='draft'?' Your changes are saved; fix this and try again.':''));
    loadDashboard();
  }finally{controls.forEach((control)=>{control.disabled=false;});}
}

// ---------- Settings: connections, team, workflow ----------

async function renderSettings(){
  const host=$('#alt-placeholder');host.classList.add('manage-host');host.replaceChildren(element('p','empty-inline','Loading settings…'));
  await Promise.all([loadConfig(),loadAccounts(),isAdminUser()?loadTeam():null]);
  if(currentView()!=='settings')return;
  const parts=[];
  if(mgr.oauthError){parts.push(note(mgr.oauthError,false));mgr.oauthError='';}
  parts.push(renderConnections(),isAdminUser()?renderTeam():renderMyAccess(),renderWorkflowGuide());
  host.replaceChildren(...parts);
}
function renderConnections(){
  const clients=state.clients;const admin=isAdminUser();
  if(!mgr.settingsClient||!clients.some((client)=>client.id===mgr.settingsClient)){
    mgr.settingsClient=(state.selectedClient!=='all'&&state.selectedClient)||clients[0]?.id||'';
  }
  const picker=element('select','inline-select');picker.setAttribute('aria-label','Client');
  clients.forEach((client)=>picker.add(new Option(client.name,client.id)));picker.value=mgr.settingsClient;
  picker.addEventListener('change',()=>{mgr.settingsClient=picker.value;renderSettings();});
  const box=section('Social accounts',admin
    ?'Connect each client’s profiles through the platform’s official sign-in. Access tokens are encrypted and never shown to the team.'
    :'Profiles connected for your clients. Only the workspace admin can connect or remove them.',clients.length?picker:null);
  if(!clients.length){box.append(element('p','empty-inline',admin?'Add a client first with the + next to Client portfolio.':'You are not assigned to any clients yet.'));return box;}
  const config=mgr.config||{providers:{}};
  if(admin){
    if(!config.encryption)box.append(note('Token encryption is not set up yet. Add the TOKEN_ENCRYPTION_KEY secret before connecting accounts (see SOCIAL_SETUP.md).',false));
    const grid=element('div','connect-grid');
    for(const platform of ['facebook','instagram','tiktok','youtube']){
      const ready=config.providers?.[platform]?.configured&&config.encryption;const card=element('div','connect-card');
      card.append(iconFor(platform,false),element('b','',platforms[platform].label),
        element('small','',config.providers?.[platform]?.configured?CONNECT_HELP[platform]:'Needs the platform’s developer app keys first. See SOCIAL_SETUP.md.'));
      const connect=linkButton('Connect '+platforms[platform].label,ready?'button-primary':'button-quiet','/api/oauth/start?'+new URLSearchParams({platform,clientId:mgr.settingsClient}));
      if(!ready)connect.setAttribute('aria-disabled','true');card.append(connect);grid.append(card);
    }
    box.append(grid);
  }
  const list=element('div');const accounts=mgr.accounts.filter((account)=>account.client_id===mgr.settingsClient);
  if(!accounts.length)list.append(element('p','empty-inline','No accounts connected for this client yet.'));
  for(const account of accounts){
    const row=element('div','account-row');const main=element('div','row-main');
    const name=element('b');name.append(iconFor(account.platform),document.createTextNode(' '+account.display_name));main.append(name);
    main.append(element('small','',account.status==='connected'
      ?'Connected '+dateLabel(account.connected_at)+(account.connected_by_email?' by '+account.connected_by_email:'')
      :(account.last_error||'Reconnect this account to keep publishing.')));
    const actions=element('div','row-actions');
    if(/^https:\/\//.test(account.profile_url||''))actions.append(linkButton('Open ↗','button-quiet button-small',account.profile_url,true));
    if(admin){
      if(account.status!=='connected')actions.append(linkButton('Reconnect','button-primary button-small','/api/oauth/start?'+new URLSearchParams({platform:account.platform,clientId:account.client_id})));
      actions.append(actionButton('Disconnect','button-danger button-small',async()=>{
        if(!confirm('Disconnect '+account.display_name+'? Posts waiting to publish to it will fail until it is reconnected.'))return;
        try{await api('/accounts/'+account.id,{method:'DELETE'});toast('Account disconnected.');await loadDashboard();renderSettings();}catch(error){toast(error.message);}
      }));
    }
    row.append(avatar(account),main,pill(account.status),actions);list.append(row);
  }
  box.append(list);return box;
}
function renderTeam(){
  const box=section('Team & permissions','Invite collaborators by work email, give them a role and choose the clients they work on. Only invited @bouquet-innovation.net addresses can sign in.',actionButton('＋ Invite collaborator','button-primary',openInvite));
  const list=element('div');
  for(const member of mgr.team){
    const locked=member.email===ADMIN_ADDRESS||member.id===state.user.id;const row=element('div','member-row');
    const main=element('div','row-main');
    main.append(element('b','',member.display_name||member.email),element('small','',member.display_name?member.email:(member.last_login_at?'Last active '+dateLabel(member.last_login_at):'Has not signed in yet')));
    const roleCell=element('div','member-role');
    if(locked)roleCell.append(pill('approved',ROLE_INFO[member.role]?.[0]||member.role));
    else{
      const select=element('select','inline-select');select.setAttribute('aria-label','Role for '+member.email);
      for(const [key,[label]] of Object.entries(ROLE_INFO))select.add(new Option(label,key));select.value=member.role;
      select.addEventListener('change',()=>updateMember(member.id,{role:select.value},'Role updated.'));roleCell.append(select);
    }
    const chips=element('div','client-chips');
    if(member.role==='admin')chips.append(element('span','','All clients'));
    else{const names=state.clients.filter((client)=>(member.client_ids||[]).includes(client.id)).map((client)=>client.name);if(!names.length)chips.append(element('span','','No clients assigned'));names.forEach((label)=>chips.append(element('span','',label)));}
    const status=element('div','member-status');status.append(pill(member.status));
    const actions=element('div','row-actions');
    if(!locked){
      if(member.role!=='admin')actions.append(actionButton('Clients','button-quiet button-small',()=>openMemberClients(member)));
      if(member.status==='invited')actions.append(actionButton('Resend invite','button-quiet button-small',async()=>{try{await api('/team/'+member.id+'/resend',{method:'POST',body:'{}'});toast('Invitation sent again.');}catch(error){toast(error.message);}}));
      actions.append(member.status==='disabled'
        ?actionButton('Reactivate','button-quiet button-small',()=>updateMember(member.id,{status:'active'},'Access restored. They can sign in again.'))
        :actionButton('Deactivate','button-danger button-small',()=>{if(confirm('Remove '+member.email+'’s access? They are signed out immediately.'))updateMember(member.id,{status:'disabled'},'Access removed.');}));
    }
    row.append(main,roleCell,chips,status,actions);list.append(row);
  }
  box.append(list);
  const guide=element('div','role-guide');
  for(const [,[label,text]] of Object.entries(ROLE_INFO)){const item=element('div');item.append(element('b','',label),element('p','',text));guide.append(item);}
  box.append(element('h3','planner-day','What each role can do'),guide);return box;
}
function renderMyAccess(){
  const box=section('Your access','Your role decides what you can do here. Ask the workspace admin if you need more.');
  const [label,text]=ROLE_INFO[roleOf()]||ROLE_INFO.viewer;const guide=element('div','role-guide');const item=element('div');item.append(element('b','',label),element('p','',text));guide.append(item);box.append(guide);
  const chips=element('div','client-chips');state.clients.forEach((client)=>chips.append(element('span','',client.name)));
  if(!state.clients.length)chips.append(element('span','','No clients assigned yet'));
  box.append(element('h3','planner-day','Your clients'),chips);return box;
}
function renderWorkflowGuide(){
  const box=section('How publishing works','Every post follows the same path, and each step is recorded in the post’s activity log.');
  const steps=[
    ['Draft','Write the post, choose the client’s accounts, attach media and propose a time.'],
    ['Submit','Editors submit the draft. Managers and the admin get an email.'],
    ['Review','A manager approves it, or sends it back with a comment. The author is emailed.'],
    ['Schedule','Approved posts with a time join the queue. Managers can also publish right away.'],
    ['Publish','At the set time each account is posted to and its link saved. Failures are emailed with the reason.']
  ];
  const list=element('ol','flow-steps');for(const [title,text] of steps){const li=element('li');li.append(element('b','',title),document.createTextNode(text));list.append(li);}
  box.append(list);
  if(mgr.config&&!mgr.config.scheduler)box.append(note('The scheduler store is not connected, so scheduled posts are only checked every 10 minutes.',false));
  return box;
}
async function updateMember(id,changes,message){
  try{await api('/team/'+id,{method:'PATCH',body:JSON.stringify(changes)});toast(message);}catch(error){toast(error.message);}
  await loadTeam();if(currentView()==='settings')renderSettings();
}
function clientChecks(container,selected){
  container.replaceChildren();if(!state.clients.length)container.append(element('p','empty-inline','Add a client first.'));
  for(const client of state.clients){const label=element('label');const input=element('input');input.type='checkbox';input.value=client.id;input.checked=selected.includes(client.id);label.append(input,element('span','',client.name));container.append(label);}
}
function openInvite(){$('#invite-form').reset();clearError('#invite-error');clientChecks($('#invite-clients'),[]);openDialog('#invite-dialog');}
function openMemberClients(member){
  mgr.editingMember=member.id;$('#member-clients-title').textContent='Clients for '+(member.display_name||member.email.split('@')[0])+'.';
  clientChecks($('#member-clients-list'),member.client_ids||[]);openDialog('#member-clients-dialog');
}

// ---------- Hooks called from app.js ----------

function handleOAuthReturn(){
  const query=new URLSearchParams(location.search);if(!query.has('connected')&&!query.has('oauth_error'))return;
  if(query.has('connected')){const count=Number(query.get('count')||1);toast('Connected '+count+' '+(platforms[query.get('connected')]?.label||'')+' account'+(count===1?'':'s')+'.');}
  if(query.has('oauth_error'))mgr.oauthError=query.get('oauth_error');
  history.replaceState(null,'',location.pathname+location.hash);
}
function routeFromHash(){
  const [view,id]=location.hash.slice(1).split('/');
  if(view&&view!=='overview'&&views[view])$$('.nav-item[data-view]').find((item)=>item.dataset.view===view)?.click();
  if(view==='planner'&&UUID_PATTERN.test(id||''))openPost(id);
}
window.onWorkspaceReady=async()=>{
  await Promise.all([loadConfig(),loadAccounts()]);
  $('#compose-btn').hidden=!canEditUser();$('#alt-compose').hidden=!canEditUser();$('#task-add').hidden=!canEditUser();
  handleOAuthReturn();routeFromHash();
};
window.onDashboard=(data)=>{
  state.counts=data.counts||{};
  const badge=$('#nav-review-count');badge.textContent=state.counts.review||0;badge.hidden=!state.counts.review;
  $('#usage-count').textContent=state.counts.publishedThisMonth||0;
  $('#usage-note').textContent=state.counts.failed?state.counts.failed+' post'+(state.counts.failed===1?' needs':'s need')+' attention':'No failed posts';
  if(!$('#compose-dialog').open){const known=new Set(mgr.accounts.map((account)=>account.client_id));if(state.clients.some((client)=>!known.has(client.id)&&Number(client.connected_platforms)>0))loadAccounts();}
};
window.renderManageView=(view)=>{
  const host=$('#alt-placeholder');host.classList.remove('manage-host');
  if(view==='planner')renderPlanner();else if(view==='settings')renderSettings();
};
window.onClientSelected=()=>{
  if(currentView()==='planner')renderPlanner();
  if(currentView()==='settings'){mgr.settingsClient=state.selectedClient!=='all'?state.selectedClient:mgr.settingsClient;renderSettings();}
};
window.openPost=openPost;
window.openCompose=openCompose;

(function wireManagement(){
  $('#compose-close').addEventListener('click',()=>closeDialog('#compose-dialog'));
  $('#client-select').addEventListener('change',()=>renderAccountPicks(null));
  $('#post-copy').addEventListener('input',updateCopyCount);
  $('#media-upload-btn').addEventListener('click',()=>$('#media-file').click());
  $('#media-file').addEventListener('change',async(event)=>{for(const file of [...event.target.files])await uploadMediaFile(file);event.target.value='';});
  $('#media-url-add').addEventListener('click',addMediaUrl);
  $('#media-url').addEventListener('keydown',(event)=>{if(event.key==='Enter'){event.preventDefault();addMediaUrl();}});
  $('#save-draft-btn').addEventListener('click',()=>saveCompose('draft'));
  $('#submit-review-btn').addEventListener('click',()=>saveCompose('submit'));
  $('#publish-now-btn').addEventListener('click',()=>saveCompose('publish_now'));
  $('#compose-form').addEventListener('submit',(event)=>{event.preventDefault();saveCompose(canApproveUser()?'schedule':'submit');});
  $('#tz-label').textContent=Intl.DateTimeFormat().resolvedOptions().timeZone||'';
  $('#invite-form').addEventListener('submit',async(event)=>{
    event.preventDefault();clearError('#invite-error');const control=$('#invite-form button[type=submit]');setBusy(control,true,'Sending…');
    try{
      await api('/team',{method:'POST',body:JSON.stringify({
        email:$('#invite-email').value,displayName:$('#invite-name').value,role:$('#invite-role').value,
        clientIds:$$('#invite-clients input:checked').map((input)=>input.value)
      })});
      closeDialog('#invite-dialog');toast('Invitation sent.');
    }catch(error){formError('#invite-error',error.message);}
    finally{setBusy(control,false);await loadTeam();await loadConfig();if(currentView()==='settings')renderSettings();}
  });
  $('#member-clients-form').addEventListener('submit',async(event)=>{
    event.preventDefault();closeDialog('#member-clients-dialog');
    await updateMember(mgr.editingMember,{clientIds:$$('#member-clients-list input:checked').map((input)=>input.value)},'Client access updated.');
  });
  $('#task-add').addEventListener('click',()=>{
    const assignee=$('#task-assignee');assignee.replaceChildren(new Option('Me',''));
    (mgr.config?.members||[]).filter((member)=>member.id!==state.user.id).forEach((member)=>assignee.add(new Option(member.displayName||member.email,member.id)));
    const client=$('#task-client');client.replaceChildren(new Option('No specific client',''));
    state.clients.forEach((item)=>client.add(new Option(item.name,item.id)));
    if(state.selectedClient&&state.selectedClient!=='all')client.value=state.selectedClient;
  });
})();
