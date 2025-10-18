async function UpdateCandidate(
  parent,
  args,
  context
) {
  const {
    _id,
    candidate_input,
    lang,
    new_desired_program,
    is_from_admission_form,
    is_prevent_resend_notif,
    is_save_identity_student,
    is_minor_student,
  } = args;

  // REFACTOR START: get user id from context
  const getUserIdFromContext = () => {
    const tokenUser = String(context?.req?.headers?.authorization || '').replace('Bearer ', '').replace(/"/g, '')
    const userId = tokenUser && tokenUser !== 'undefined' ? common.getUserId(tokenUser) : null;
    return userId;
  }

  let userId = getUserIdFromContext();
  // REFACTOR END: get user id from context

  // *************** find candidate first before update
  const candidateBeforeUpdate = await CandidateModel.findById(_id).select('iban payment_supports parents').lean();

  // REFACTOR START: convert candidate input
  const normalizeCandidateData = (candidateData) => {
    candidateData.school = String(candidateData.school).toUpperCase();
    candidateData.campus = String(candidateData.campus).toUpperCase();
    candidateData.civility = candidateData.civility === 'neutral' ? candidateData.sex = 'N' : candidateData.sex = candidateData.civility === 'MR' ? 'M' : 'F';
    candidate.tag_ids = candidate?.tag_ids || []

    return candidateData;
  };

  normalizeCandidateData(candidate_input);
  // REFACTOR END: convert candidate input


  // REFACTOR START: Creates an IBAN history record, validates the IBAN/BIC, and updates the record with the result.

  const processAndValidateIban = async (ibanDetails) => {
    // 1. Create the initial history record
    const ibanHistory = await IbanHistoryModel.create(ibanDetails);

    try {
      // 2. Attempt to validate the IBAN and BIC
      await CandidateUtility.validateIbanBicCandidate(ibanDetails.iban, ibanDetails.bic);

      // 3. On success, update the record's message
      await IbanHistoryModel.updateOne({ _id: ibanHistory._id }, { $set: { message: 'success' } });
    } catch (error) {
      // 4. On failure, update the record with the error message
      await IbanHistoryModel.updateOne({ _id: ibanHistory._id }, { $set: { message: error.message } });

      // 5. Re-throw the error to stop the process
      throw new ApolloError(error.message);
    }
  };
  // Combine all financial supporters (parents and payment_supports) into a single array
  const allSupporters = [
    ...(candidate_input.parents ?? []),
    ...(candidate_input.payment_supports ?? [])
  ];

  // Prepare a list of all IBAN validation tasks
  const validationTasks = [];

  // 1. Add the main candidate's IBAN task if it exists
  if (candidate_input.iban && candidate_input.bic && candidate_input.account_holder_name) {
    validationTasks.push(
      processAndValidateIban({
        candidate_id: _id,
        iban: candidate_input.iban,
        bic: candidate_input.bic,
        account_holder_name: candidate_input.account_holder_name,
      })
    );
  }

  // 2. Add tasks for all supporters' IBANs
  for (const supporter of allSupporters) {
    if (supporter.iban && supporter.bic && supporter.account_holder_name) {
      validationTasks.push(
        processAndValidateIban({
          candidate_id: _id,
          iban: supporter.iban,
          bic: supporter.bic,
          account_holder_name: supporter.account_holder_name,
          financial_support_first_name: supporter.name,
          financial_support_last_name: supporter.family_name,
        })
      );
    }
  }

  // 3. Execute all validation tasks concurrently
  if (validationTasks.length > 0) {
    await Promise.all(validationTasks);
  }

  // REFACTOR END: Creates an IBAN history record, validates the IBAN/BIC, and updates the record with the result.

  // REFACTOR START: validation candidate before update

  // Only proceed if there's a previous state to compare against
  if (candidateBeforeUpdate) {
    const historyCreationTasks = [];

    // --- 1. Check the main candidate's IBAN ---
    const { iban: beforeIban } = candidateBeforeUpdate;
    const { iban: afterIban } = candidate_input;

    // Log a change if the new IBAN was provided in the input and is different from the old one.
    // This correctly handles updates, additions, and removals (e.g., setting IBAN to '').
    if (afterIban !== undefined && beforeIban !== afterIban) {
      historyCreationTasks.push(
        IbanHistoryUpdateModel.create({
          candidate_id: _id,
          iban: afterIban,
          iban_before_update: beforeIban || null, // Ensure a value is always sent
          user_who_update_id: userId,
        })
      );
    }

    // --- 2. Check all financial supporters (Parents & Payment Supports) efficiently ---

    // Combine both 'parents' and 'payment_supports' into single arrays
    const beforeSupporters = [
      ...(candidateBeforeUpdate.parents ?? []),
      ...(candidateBeforeUpdate.payment_supports ?? []),
    ];
    const afterSupporters = [
      ...(candidate_input.parents ?? []),
      ...(candidate_input.payment_supports ?? []),
    ];

    // Create a Map of the "after" supporters for fast, O(1) lookups
    const afterSupportersMap = new Map(
      afterSupporters.map(supporter => [String(supporter._id), supporter])
    );

    // Loop through the "before" supporters to find changes
    for (const beforeSupporter of beforeSupporters) {
      const afterSupporter = afterSupportersMap.get(String(beforeSupporter._id));

      // A change occurred if the supporter still exists and their IBAN is different
      if (afterSupporter && beforeSupporter.iban !== afterSupporter.iban) {
        historyCreationTasks.push(
          IbanHistoryUpdateModel.create({
            candidate_id: _id,
            iban: afterSupporter.iban,
            iban_before_update: beforeSupporter.iban,
            user_who_update_id: userId,
            financial_support_first_name: afterSupporter.name,
            financial_support_last_name: afterSupporter.family_name,
          })
        );
      }
    }

    // --- 3. Execute all database writes concurrently for maximum speed ---
    if (historyCreationTasks.length > 0) {
      await Promise.all(historyCreationTasks);
    }
  }
  // REFACTOR END: validation candidate before update


  // REFACTOR START: validation legal representative, civility, finance failsafe
  const nowTime = moment.utc();
  const oldCandidate = await CandidateModel.findById(_id);

  // ******************* check if unique_id is exist in legal representative, if exist, then use old representative, otherwise create new using UUID
  // Check if legal_representative exists and lacks unique_id; if so, assign from oldCandidate or generate new UUID
  if (candidate_input.legal_representative && !candidate_input.legal_representative.unique_id) {
    candidate_input.legal_representative.unique_id = oldCandidate.legal_representative?.unique_id || common.create_UUID();
  }

  // Set civility for legal representative based on parental_link
  const rep = candidate_input.legal_representative;
  if (rep && !rep.civility && rep.parental_link) {
    const relations = ['father', 'grandfather', 'uncle'];
    const link = rep.parental_link;
    candidate_input.legal_representative.civility = link === 'other' ? '' : relations.includes(link) ? 'MR' : 'MRS';
  }
  // Convert last_name to uppercase
  if (rep?.last_name) {
    candidate_input.legal_representative.last_name = rep.last_name.toUpperCase();
  }
  // Failsafe: Set finance if not set and conditions met
  if (!candidate_input.finance && !oldCandidate.finance && oldCandidate.selected_payment_plan?.payment_mode_id) {
    const hasPaymentSupports = (candidate_input.payment_supports?.length || oldCandidate.payment_supports?.length);
    candidate_input.finance = hasPaymentSupports ? 'family' : 'my_self';
  }

  // REFACTOR END: validation legal representative, civility, finance failsafe



  // REFACTOR START: old selected payment plan data without _id in payment_date terms
  const oldSelectedPaymentPlanData = JSON.parse(JSON.stringify(oldCandidate.selected_payment_plan));
  oldSelectedPaymentPlanData.payment_date = oldSelectedPaymentPlanData.payment_date.map(({ _id, ...term }) => term);
  // REFACTOR END: old selected payment plan data without _id in payment_date terms


  // REFACTOR START: Update email and recovery code if candidate is registered and email changed 
  // Update email and recovery code if candidate is registered and email changed
  if (
    oldCandidate?.user_id &&
    oldCandidate.candidate_admission_status === 'registered' &&
    candidate_input?.email &&
    oldCandidate.email !== candidate_input.email
  ) {
    await UserModel.updateOne(
      { _id: oldCandidate.user_id },
      { $set: { email: candidate_input.email, recovery_code: '' } },
      { new: true }
    );
    await CandidateModel.updateOne({ _id: oldCandidate._id }, { $set: { email: candidate_input.email } });
    await CandidateUtility.Send_STUD_REG_N1(oldCandidate._id, lang);
  }
  // REFACTOR END: Update email and recovery code if candidate is registered and email changed 

  // REFACTOR START: Validate payment plan changes
  // Prevent payment plan changes if already selected
  if (
    oldSelectedPaymentPlanData?.total_amount > 0 &&
    candidate_input?.selected_payment_plan &&
    typeof oldSelectedPaymentPlanData === 'object' &&
    typeof candidate_input.selected_payment_plan === 'object'
  ) {
    for (const [key, value] of Object.entries(candidate_input.selected_payment_plan)) {
      if (String(value) !== String(oldSelectedPaymentPlanData[key])) {
        throw new ApolloError('Payment plan is already selected!');
      }
    }
  }
  // REFACTOR END: Validate payment plan changes

  // REFACTOR START: Validate input if no admission_process_id and conditions met
  // Set userId if missing
  userId ||= oldCandidate.user_id;

  // Validate input if no admission_process_id and conditions met
  if (!oldCandidate.admission_process_id) {
    if (is_from_admission_form || (candidate_input.payment_method && candidate_input.payment_method !== oldCandidate.payment_method)) {
      await CandidateUtility.validateCandidateInput(candidate_input, oldCandidate);

      if (['registered', 'engaged', 'resigned_after_engaged', 'resigned_after_registered'].includes(oldCandidate.candidate_admission_status)) {
        const current_step = await CandidateUtility.getCandidateCurrentStep(oldCandidate);
        if (!candidate_input.payment_method && current_step !== 'down_payment') {
          throw new ApolloError('Cannot edit data, candidate already signed school contract!');
        }
      }
    }
  }
  // REFACTOR END: Validate input if no admission_process_id and conditions met


  // REFACTOR START: update candidate status, and validation on readmission assignment table
  // Helper to get candidate IDs with same student_id
  const getCandidateIds = async (candidateId) => {
    const candidate = await CandidateModel.findById(candidateId).select('student_id').lean();
    const candidates = await CandidateModel.find({ student_id: candidate.student_id }).select('_id').lean();
    return candidates.map(c => c._id);
  };
  // Update is_student_resigned based on status change
  const resignedStatuses = ['resigned', 'resigned_after_engaged', 'resigned_after_registered', 'no_show', 'resignation_missing_prerequisites', 'resign_after_school_begins', 'report_inscription'];
  if (candidate_input.candidate_admission_status) {
    const oldStatus = oldCandidate.candidate_admission_status;
    const newStatus = candidate_input.candidate_admission_status;
    let isResigned = null;
    if (oldStatus === 'registered' && resignedStatuses.includes(newStatus)) {
      isResigned = true;
    } else if (resignedStatuses.includes(oldStatus) && newStatus === 'registered') {
      isResigned = false;
    }
    if (isResigned !== null) {
      const candidateIds = await getCandidateIds(oldCandidate._id);
      await CandidateModel.updateMany(
        { _id: { $in: candidateIds }, readmission_status: 'assignment_table' },
        { $set: { is_student_resigned: isResigned } }
      );
    }
  }
  // REFACTOR END: update candidate status, and validation on readmission assignment table

  // REFACTOR START: process change step status for continuous formation student
  // Fetch type of formation and define continuous types
  const typeOfFormation = await TypeOfFormationModel.findById(oldCandidate.type_of_formation_id);
  const continuousTypeOfFormation = ['continuous', 'continuous_total_funding', 'continuous_partial_funding', 'continuous_personal_funding', 'continuous_contract_pro'];
  const isContinuousOrReadmission = typeOfFormation && (continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) || oldCandidate.readmission_status === 'readmission_table');

  // Fetch admission process if exists
  let admissionProcess = null;
  if (oldCandidate.admission_process_id) {
    admissionProcess = await FormProcessModel.findById(oldCandidate.admission_process_id)
      .populate([
        { path: 'steps form_builder_id', populate: { path: 'steps' } },
        { path: 'candidate_id', populate: { path: 'continuous_formation_manager_id' } }
      ])
      .exec();

    // Special case: Accept down_payment_mode if payment_method is 'cash'
    if (candidate_input.payment_method === 'cash') {
      const downPaymentStep = admissionProcess?.steps?.find(step => step.step_type === 'down_payment_mode');
      if (downPaymentStep) {
        await FormProcessStepModel.findByIdAndUpdate(downPaymentStep._id, { $set: { step_status: 'accept' } });
        await CandidateUtility.updateCandidateAdmissionStatusFromAdmissionProcessStep(_id, downPaymentStep._id, context.userId, lang);
        await StudentAdmissionProcessUtilities.validateStatusStepFinalMessage(admissionProcess._id);
      }
    }
  }

  // Helper to accept a step if conditions met
  const acceptStep = async (stepType, condition, postActions) => {
    if (condition && admissionProcess?.steps?.length) {
      const step = admissionProcess.steps.find(s => s.step_type === stepType);
      if (step) {
        await FormProcessStepModel.findByIdAndUpdate(step._id, { $set: { step_status: 'accept' } }, stepType === 'summary' ? { new: true } : {});
        await CandidateUtility.updateCandidateAdmissionStatusFromAdmissionProcessStep(_id, step._id, context.userId, lang);
        if (postActions) await postActions(step);
      }
    }
  };

  // Accept down_payment_mode step (general case)
  const paymentChanged = candidate_input.payment_method && candidate_input.payment_method !== oldCandidate.payment_method && !['credit_card', 'sepa', 'transfer', 'check', 'bank'].includes(candidate_input.payment_method);
  acceptStep('down_payment_mode', isContinuousOrReadmission && (paymentChanged || candidate_input.payment === 'no_down_payment'), async (step) => {
    if (typeOfFormation.type_of_formation === 'classic') {
      await CandidateUtility.proceedRegisteredStudent(_id, lang);
    }
  });

  // Accept campus_validation step
  acceptStep('campus_validation', isContinuousOrReadmission && candidate_input.program_confirmed === 'done');

  // Accept summary step
  acceptStep('summary', isContinuousOrReadmission && candidate_input.signature === 'done', async (step) => {
    await FormProcessModel.findByIdAndUpdate(oldCandidate.admission_process_id, {
      $set: { signature_date: { date: nowTime.format('DD/MM/YYYY'), time: nowTime.format('HH:mm') } }
    });
    candidate_input.candidate_sign_date = { date: nowTime.format('DD/MM/YYYY'), time: nowTime.format('HH:mm') };
    const summarySchoolPdf = await StudentAdmissionProcessUtility.generatePDFStep(_id, step._id, lang);
    candidate_input.school_contract_pdf_link = summarySchoolPdf;
  });

  // REFACTOR END: process change step status for continuous formation student


  // REFACTOR START: various candidate input adjustments and validations
  // Update payment status based on method and old status
  if (candidate_input.payment_method && ['check', 'transfer'].includes(candidate_input.payment_method) && oldCandidate.payment === 'not_authorized') {
    candidate_input.payment = 'not_done';
  }

  if (oldCandidate.payment === 'done' && candidate_input.payment === 'pending') {
    candidate_input.payment = oldCandidate.payment;
  }

  if (candidate_input.payment_method && oldCandidate.payment_method === candidate_input.payment_method) {
    candidate_input.payment = oldCandidate.payment;
  }

  // Validate IBAN if finance changed to 'my_self' and method is 'sepa'
  if (candidate_input.finance && oldCandidate.finance !== candidate_input.finance && candidate_input.finance === 'my_self') {
    if (oldCandidate.method_of_payment === 'sepa' && !is_save_identity_student) {
      if (!candidate_input.iban || !candidate_input.bic || !candidate_input.account_holder_name) {
        throw new ApolloError('Answer of question is required');
      }
      const checkIban = await IbanHistoryModel.findOne({ candidate_id: oldCandidate._id }).sort({ _id: -1 }).lean();
      if (!checkIban || checkIban.message !== 'success') {
        throw new ApolloError('IBAN not verified');
      }
    }
  }

  // Helper to filter valid data based on required fields
  const filterValidData = (data, requiredFields) => data.filter(item => requiredFields.every(field => item[field]));

  // Filter valid parents data
  if (candidate_input.parents?.length) {
    candidate_input.parents = filterValidData(candidate_input.parents, ['family_name', 'name', 'email']);
  }

  // Filter valid payment supports data
  if (candidate_input.payment_supports?.length) {
    candidate_input.payment_supports = filterValidData(candidate_input.payment_supports, ['family_name', 'name', 'email']);
  }

  // Save history for legal representative
  await CandidateUtility.SaveHistoryLegalRepresentative(candidate_input, _id, userId);
  // REFACTOR END: various candidate input adjustments and validations



  // REFACTOR START: Update CVEC and INE numbers both in candidate and related form processes
  //*********** When cvec_number or ine_number is updated from student card also update it to the cvec form to the cvec_number field and ine_number field of the question and field step
  if (candidate_input.cvec_number || candidate_input.ine_number) {
    // Normalize input to uppercase
    ['cvec_number', 'ine_number'].forEach(key => {
      if (candidate_input[key]) candidate_input[key] = candidate_input[key].toUpperCase();
    });

    // Helper function to update questions
    const updateQuestions = async (formProcesses) => {
      for (const form of formProcesses) {
        for (const step of form.steps || []) {
          if (step.step_type !== 'question_and_field' || step.step_status !== 'accept') continue;
          for (const segment of step.segments || []) {
            for (const question of segment.questions || []) {
              const fieldType = question.field_type;
              const newValue = candidate_input[fieldType];
              if (newValue && question.answer.toLowerCase() !== newValue.toLowerCase()) {
                await FormProcessQuestionModel.findByIdAndUpdate(
                  question._id,
                  { $set: { answer: newValue } },
                  { new: true }
                );
              }
            }
          }
        }
      }
    };

    // Get relevant form processes
    let formProcesses = [];
    if (oldCandidate.cvec_form_process_id) {
      const process = await FormProcessModel.findById(oldCandidate.cvec_form_process_id)
        .populate([{ path: 'steps', populate: [{ path: 'segments.questions' }] }])
        .lean();
      if (process) formProcesses.push(process);
    } else {
      const formBuilderIds = await FormBuilderModel.distinct('_id', {
        status: 'active',
        template_type: 'one_time_form',
      });

      formProcesses = await FormProcessModel.find({
        status: 'active',
        candidate_id: oldCandidate._id,
        form_builder_id: { $in: formBuilderIds },
      })
        .populate([{ path: 'steps', populate: [{ path: 'segments.questions' }] }])
        .lean();
    }

    // Perform updates
    if (formProcesses.length) await updateQuestions(formProcesses);
  }

  // Finally, update candidate record
  const updatedCandidate = await CandidateModel.findByIdAndUpdate(_id, { $set: candidate_input }, { new: true });
  // REFACTOR END: Update CVEC and INE numbers both in candidate and related form processes


  // REFACTOR START: process to accept step scholarship fee and generate billing
  // process to accept step scholarship fee
  // Process to accept scholarship fee step
  const oldSelectedPaymentPlan = {
    ...oldCandidate.selected_payment_plan,
    payment_date: oldCandidate.selected_payment_plan.payment_date.map(({ _id, ...term }) => term),
  };

  const newPlan = candidate_input.selected_payment_plan;
  const isPlanChanged = newPlan && typeof newPlan === 'object' && JSON.stringify(oldSelectedPaymentPlan) !== JSON.stringify(newPlan);

  if (isPlanChanged && typeOfFormation) {
    const { type_of_formation } = typeOfFormation;
    const isContinuous = continuousTypeOfFormation.includes(type_of_formation);
    const isReadmission = oldCandidate.readmission_status === 'readmission_table';

    // Admission FC / Re-Admission
    if (isContinuous || isReadmission) {
      const step = admissionProcess?.steps?.find(s => s.step_type === 'scholarship_fee');
      if (step) {
        await FormProcessStepModel.findByIdAndUpdate(step._id, { $set: { step_status: 'accept' } }, { new: true });
        await CandidateUtility.updateCandidateAdmissionStatusFromAdmissionProcessStep(_id, step._id, context.userId, lang);
      }
    }

    // Admission FI
    if (type_of_formation === 'classic' && !oldCandidate.readmission_status) {
      const updateFinance = Object.entries(newPlan).some(
        ([key, val]) => String(val) !== String(oldSelectedPaymentPlan[key])
      );
      if (updateFinance) {
        await CandidateUtility.updateCandidateBilling(oldCandidate, updatedCandidate, context.userId);
      }
    }
  }

  // REFACTOR END: process to accept step scholarship fee and generate billing

  // Generate Billing if scholarship fee is accepted
  // const admissionProcessUpdated = await StudentAdmissionProcessModel.findById(updatedCandidate.admission_process_id)
  // Generate billing if scholarship fee is newly accepted
  const admissionProcessUpdated = await FormProcessModel
    .findById(updatedCandidate.admission_process_id)
    .populate('steps')
    .lean();

  const scholarshipStep = admissionProcessUpdated?.steps?.find(s => s.step_type === 'scholarship_fee');
  const isContinuous = typeOfFormation && continuousTypeOfFormation.includes(typeOfFormation.type_of_formation);
  const isReadmission = oldCandidate.readmission_status === 'readmission_table';

  if (
    (isContinuous || isReadmission) &&
    scholarshipStep?.step_status === 'accept' &&
    oldScholarshipStep?.step_status !== 'accept'
  ) {
    await CandidateUtility.updateCandidateBilling(oldCandidate, updatedCandidate, context.userId);
  }

  // update user data
  let userCandidate = await UserModel.findById(updatedCandidate.user_id);
  if (userCandidate) {
    userCandidate.user_addresses[0] = {
      address: updatedCandidate.address,
      postal_code: updatedCandidate.post_code,
      country: updatedCandidate.country,
      city: updatedCandidate.city,
      department: updatedCandidate.department,
      region: updatedCandidate.region,
    };
  }

  await UserModel.findByIdAndUpdate(updatedCandidate.user_id, {
    $set: {
      last_name: updatedCandidate.last_name,
      first_name: updatedCandidate.first_name,
      civility: updatedCandidate.civility,
      sex: updatedCandidate.civility === 'neutral' ? 'N' : updatedCandidate.sex,
      user_addresses: (userCandidate && userCandidate.user_addresses) || undefined,
      email: updatedCandidate.email,
      portable_phone: updatedCandidate.telephone,
      office_phone: updatedCandidate.fixed_phone,
    },
  });

  await CandidateHistoryUtility.createNewCandidateHistory(_id, userId, 'update_candidate');

  if (candidate_input.student_mentor_id && updatedCandidate.student_mentor_id) {
    await StudentModel.updateOne({ _id: updatedCandidate.student_mentor_id }, { $set: { is_candidate_mentor: true } });
  }


  // REFACTOR START: process bulk update for admission member, student mentor, campus changes
  // Handle Admission Member update
  const bulkUpdateCandidateQuery = [];
  const hasNewAdmissionMember =
    candidate_input.admission_member_id &&
    String(oldCandidate.admission_member_id) !== String(updatedCandidate.admission_member_id);

  if (hasNewAdmissionMember) {
    const oldAdmissionMemberId = oldCandidate.admission_member_id;

    if (!userId) {
      await CandidateModel.updateOne({ _id }, { $set: oldCandidate });
      throw new AuthenticationError('Authorization header is missing');
    }

    const now = {
      date: nowTime.format('DD/MM/YYYY'),
      time: nowTime.format('HH:mm'),
    };

    bulkUpdateCandidateQuery.push(
      {
        updateOne: {
          filter: {
            _id,
            'admission_member_histories.admission_member_status': 'active',
            'admission_member_histories.admission_member_id': mongoose.Types.ObjectId(oldAdmissionMemberId),
          },
          update: {
            $set: {
              'admission_member_histories.$.admission_member_status': 'not_active',
              'admission_member_histories.$.deactivation_date': now.date,
              'admission_member_histories.$.deactivation_time': now.time,
            },
          },
        },
      },
      {
        updateOne: {
          filter: { _id },
          update: {
            $push: {
              admission_member_histories: {
                admission_member_id: candidate_input.admission_member_id,
                activation_date: now.date,
                activation_time: now.time,
              },
            },
          },
        },
      }
    );

    await CandidateHistoryUtility.createNewCandidateHistory(
      _id,
      userId,
      'update_candidate_admission_member',
      `Admission member updated from ${oldAdmissionMemberId} to ${updatedCandidate.admission_member_id}`
    );

    // Notify new admission member
    await CandidateUtility.send_CANDIDATE_N2(
      [updatedCandidate],
      lang,
      userId,
      [null, ''].includes(oldAdmissionMemberId)
    );

    // Notify old admission member (if exists)
    if (oldAdmissionMemberId) {
      await CandidateUtility.send_CANDIDATE_N6([oldCandidate], lang, userId);
    }
  }
  // REFACTOR END: process bulk update for admission member, student mentor, campus changes


  // REFACTOR START: process student mentor update, campus update, engagement level registration
  // --- Helper for authorization check ---
  const ensureAuthorized = async () => {
    if (!userId) {
      await CandidateModel.updateOne({ _id }, { $set: oldCandidate });
      throw new AuthenticationError('Authorization header is missing');
    }
  };

  // --- Helper for formatting current time ---
  const now = {
    date: nowTime.format('DD/MM/YYYY'),
    time: nowTime.format('HH:mm'),
  };

  // --- Handle Student Mentor Update ---
  const mentorChanged =
    candidate_input.student_mentor_id &&
    String(oldCandidate.student_mentor_id) !== String(updatedCandidate.student_mentor_id);

  if (mentorChanged) {
    await ensureAuthorized();

    const oldMentorId = oldCandidate.student_mentor_id;

    bulkUpdateCandidateQuery.push(
      {
        updateOne: {
          filter: {
            _id,
            'student_mentor_histories.student_mentor_status': 'active',
            'student_mentor_histories.student_mentor_id': mongoose.Types.ObjectId(oldMentorId),
          },
          update: {
            $set: {
              'student_mentor_histories.$.student_mentor_status': 'not_active',
              'student_mentor_histories.$.deactivation_date': now.date,
              'student_mentor_histories.$.deactivation_time': now.time,
            },
          },
        },
      },
      {
        updateOne: {
          filter: { _id },
          update: {
            $push: {
              student_mentor_histories: {
                student_mentor_id: candidate_input.student_mentor_id,
                activation_date: now.date,
                activation_time: now.time,
              },
            },
          },
        },
      }
    );

    await CandidateHistoryUtility.createNewCandidateHistory(
      _id,
      userId,
      'update_candidate_student_mentor_id',
      `Student mentor updated from ${oldMentorId} to ${updatedCandidate.student_mentor_id}`
    );

    if (oldMentorId) await CandidateUtility.send_CANDIDATE_N4([oldCandidate], lang, userId); // notify old mentor
    await CandidateUtility.send_CANDIDATE_N3([updatedCandidate], lang, userId); // notify new mentor
    await CandidateUtility.send_CANDIDATE_N5([updatedCandidate], lang, userId); // notify student
  }

  // --- Handle Campus Update ---
  const campusChanged =
    candidate_input.campus && String(oldCandidate.campus) !== String(updatedCandidate.campus);

  if (campusChanged) {
    await ensureAuthorized();

    await CandidateModel.updateOne({ _id }, { $set: { campus: oldCandidate.campus } });

    bulkUpdateCandidateQuery.push({
      updateOne: {
        filter: {
          _id,
          campus_histories: {
            $not: {
              $elemMatch: { campus: candidate_input.campus, campus_status: 'pending' },
            },
          },
        },
        update: {
          $push: { campus_histories: { campus: candidate_input.campus, campus_status: 'pending' } },
        },
      },
    });

    await CandidateHistoryUtility.createNewCandidateHistory(
      _id,
      userId,
      'update_candidate_campus',
      `Campus updated from ${oldCandidate.campus} to ${updatedCandidate.campus}`
    );
  }

  // --- Handle Engagement Level Registration ---
  const justRegistered =
    candidate_input.engagement_level &&
    oldCandidate.engagement_level !== 'registered' &&
    updatedCandidate.engagement_level === 'registered';

  if (justRegistered) {
    await CandidateUtility.addRegisteredCandidateAsStudent({
      candidate: updatedCandidate,
      isSentStudRegN1: false,
      lang,
    });

    if (oldCandidate.candidate_admission_status !== 'resign_after_school_begins') {
      await CandidateUtility.send_REGISTRATION_N3(updatedCandidate);
    }

    if (!updatedCandidate.is_registration_recorded) {
      await GeneralDashboardAdmissionUtility.recordCandidateRegistered(updatedCandidate, userId);
    }

    await CandidateHistoryUtility.createNewCandidateHistory(
      _id,
      userId,
      'update_candidate_registration',
      `Candidate ${updatedCandidate._id} registered`
    );
  }

  // REFACTOR END: process student mentor update, campus update, engagement level registration

  // REFACTOR START: process candidate registration status change
  // --- Handle Admission Status Change to "Registered" ---
  const becameRegistered =
    candidate_input.candidate_admission_status &&
    oldCandidate.candidate_admission_status !== 'registered' &&
    updatedCandidate.candidate_admission_status === 'registered';

  if (becameRegistered) {
    // Register the candidate
    await CandidateUtility.addRegisteredCandidateAsStudent({ candidate: updatedCandidate, lang });

    // --- Check active candidate and readmission ---
    const [countDocs, alreadyInReadmission] = await Promise.all([
      CandidateModel.countDocuments({
        program_status: 'active',
        $or: [
          { _id: updatedCandidate._id },
          { email: updatedCandidate.email },
          { user_id: updatedCandidate.user_id },
        ],
      }),
      CandidateUtility.CheckCandidateExistInReadmission(updatedCandidate),
    ]);

    // --- Create next candidate data if not in readmission ---
    if (!alreadyInReadmission) {
      const scholarSeason = await ScholarSeasonModel.findById(updatedCandidate.scholar_season).lean();
      const today = moment().utc();

      if (scholarSeason) {
        const start = moment(scholarSeason.from.date_utc, 'DD/MM/YYYY');
        const end = moment(scholarSeason.to.date_utc, 'DD/MM/YYYY');
        const isWithinSeason = today.isBetween(start, end, 'day', '[]');

        if (isWithinSeason) {
          await CandidateModel.findByIdAndUpdate(updatedCandidate._id, {
            $set: { program_status: 'active' },
          });
        }
      }

      await CandidateUtility.createNextCandidateData(updatedCandidate);
    }

    // --- Ensure candidate exists in assignment table ---
    await CandidateUtility.checkAndCreateCandidateAssignmentTable(updatedCandidate._id);

    // --- Send registration notifications ---
    const isInitialFormation =
      typeOfFormation &&
      !continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) &&
      updatedCandidate.readmission_status !== 'readmission_table';

    if (isInitialFormation) {
      await CandidateUtility.send_REGISTRATION_N7(updatedCandidate, lang, is_prevent_resend_notif);
    } else if (updatedCandidate.readmission_status === 'readmission_table') {
      await CandidateUtility.send_READ_REG_N7(updatedCandidate, lang, is_prevent_resend_notif);
    }

    // --- Update registration timestamp ---
    await CandidateModel.findByIdAndUpdate(updatedCandidate._id, {
      $set: {
        registered_at: {
          date: moment.utc().format('DD/MM/YYYY'),
          time: moment.utc().format('HH:mm'),
        },
      },
    });

    // --- Record registration in dashboard ---
    if (!updatedCandidate.is_registration_recorded) {
      await GeneralDashboardAdmissionUtility.recordCandidateRegistered(updatedCandidate, userId);
    }

    // --- Log candidate registration ---
    await CandidateHistoryUtility.createNewCandidateHistory(
      _id,
      userId,
      'update_candidate_registration',
      `Candidate ${updatedCandidate._id} registered`
    );

    // --- Refund if transitioning from "report_inscription" to "registered" ---
    if (
      oldCandidate.candidate_admission_status === 'report_inscription' &&
      updatedCandidate.candidate_admission_status === 'registered'
    ) {
      await CandidateUtility.refundTransanctionHistoryOfCandidate(oldCandidate, updatedCandidate, userId);
    }

    // --- Reopen closed CVEC form (if resigned_before_registered) ---
    if (
      oldCandidate.closed_cvec_form_process_id &&
      oldCandidate.candidate_admission_status === 'resigned_after_registered'
    ) {
      await Promise.all([
        FormProcessModel.findByIdAndUpdate(oldCandidate.closed_cvec_form_process_id, {
          $set: { is_form_closed: false },
        }),
        CandidateModel.findByIdAndUpdate(oldCandidate._id, {
          $set: {
            cvec_form_process_id: oldCandidate.closed_cvec_form_process_id,
            closed_cvec_form_process_id: undefined,
          },
        }),
      ]);
    }

    // --- Reopen closed Admission Document form ---
    if (
      oldCandidate.closed_admission_document_process_id &&
      oldCandidate.candidate_admission_status === 'resigned_after_registered'
    ) {
      await Promise.all([
        FormProcessModel.findByIdAndUpdate(oldCandidate.closed_admission_document_process_id, {
          $set: { is_form_closed: false },
        }),
        CandidateModel.findByIdAndUpdate(oldCandidate._id, {
          $set: {
            admission_document_process_id: oldCandidate.closed_admission_document_process_id,
            closed_admission_document_process_id: undefined,
          },
        }),
      ]);
    }
  }
  // REFACTOR END: process candidate registration status change

  // REFACTOR START: Handle various candidate status transitions and related actions
  // Utility to generate a UTC timestamp
  const getUtcTimestamp = () => ({
    date: moment.utc().format('DD/MM/YYYY'),
    time: moment.utc().format('HH:mm'),
  });

  // Utility to update a candidate field with timestamp
  const updateCandidateWithTimestamp = async (id, field) => {
    await CandidateModel.findByIdAndUpdate(id, {
      $set: { [field]: getUtcTimestamp() },
    });
  };

  // Utility to close form process
  const closeFormProcess = async (processId, candidateId, updateFields) => {
    const form = await FormProcessModel.findById(processId)
      .select('steps')
      .populate([{ path: 'steps' }])
      .lean();

    if (!form || !form.steps?.length) return;

    const hasNotStartedStep = form.steps.some((s) => s.step_status === 'not_started');
    if (hasNotStartedStep) {
      await FormProcessModel.findByIdAndUpdate(processId, { $set: { is_form_closed: true } });
      await CandidateModel.findByIdAndUpdate(candidateId, { $set: updateFields });
    }
  };

  // ========== Main Logic Starts Here ==========

  // ENGAGED ➜ auto-register if no down payment
  if (
    updatedCandidate.candidate_admission_status === 'engaged' &&
    oldCandidate.candidate_admission_status !== 'engaged' &&
    typeOfFormation &&
    (!continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) ||
      oldCandidate.readmission_status !== 'readmission_table')
  ) {
    if (updatedCandidate.registration_profile) {
      const profile = await ProfileRateModel.findById(updatedCandidate.registration_profile);
      if (profile?.is_down_payment === 'no') {
        await CandidateModel.findByIdAndUpdate(_id, {
          $set: {
            candidate_admission_status: 'registered',
            registered_at: getUtcTimestamp(),
          },
        });
      }
    }

    await CandidateModel.updateOne({ _id }, { $set: { candidate_sign_date: getUtcTimestamp() } });

    if (!oldCandidate.readmission_status) {
      await CandidateUtility.send_FORM_N1(updatedCandidate, lang);
    }
  }

  // ========== Handle Resignation States ==========
  const resignationStates = [
    { key: 'resigned', field: 'resigned_at' },
    { key: 'resigned_after_engaged', field: 'resigned_after_engaged_at' },
    { key: 'resigned_after_registered', field: 'resigned_after_registered_at' },
  ];

  for (const { key, field } of resignationStates) {
    if (
      candidate_input.candidate_admission_status &&
      oldCandidate.candidate_admission_status !== key &&
      updatedCandidate.candidate_admission_status === key
    ) {
      await updateCandidateWithTimestamp(updatedCandidate._id, field);

      // Handle additional logic for resigned_after_registered
      if (key === 'resigned_after_registered') {
        const studentData = await StudentModel.findOne({ candidate_id: updatedCandidate._id });

        if (studentData?.microsoft_email) {
          const payload = {
            accountEnabled: false,
            mail: studentData.school_mail,
            givenName: studentData.first_name,
            surname: studentData.last_name,
            otherMails: [studentData.email],
            userPrincipalName: studentData.microsoft_email,
          };
          try {
            // await microsoftService.updateMicrosoftUser(payload);
          } catch (err) {
            console.error('Microsoft update failed:', err);
          }
        }

        // Handle CVEC and Admission Document closure
        if (oldCandidate.candidate_admission_status === 'registered') {
          if (oldCandidate.cvec_form_process_id) {
            await closeFormProcess(oldCandidate.cvec_form_process_id, oldCandidate._id, {
              cvec_form_process_id: undefined,
              closed_cvec_form_process_id: oldCandidate.cvec_form_process_id,
            });
          }

          if (oldCandidate.admission_document_process_id) {
            await closeFormProcess(oldCandidate.admission_document_process_id, oldCandidate._id, {
              admission_document_process_id: undefined,
              closed_admission_document_process_id: oldCandidate.admission_document_process_id,
            });
          }
        }
      }
    }
  }

  // ========== Transfer Request ==========
  if (
    candidate_input.program_confirmed &&
    oldCandidate.program_confirmed !== 'request_transfer' &&
    updatedCandidate.program_confirmed === 'request_transfer'
  ) {
    await CandidateUtility.send_Transfer_N5(_id, new_desired_program, lang);
    await CandidateUtility.send_Transfer_N6(_id, new_desired_program, lang);
  }

  // ========== Report Inscription ==========
  if (
    candidate_input.candidate_admission_status &&
    oldCandidate.candidate_admission_status !== 'report_inscription' &&
    updatedCandidate.candidate_admission_status === 'report_inscription'
  ) {
    await CandidateUtility.refundTransanctionHistoryOfCandidate(oldCandidate, updatedCandidate, userId);
    await updateCandidateWithTimestamp(_id, 'inscription_at');
    await CandidateUtility.send_StudentCard_N1(updatedCandidate, lang);
  }

  // ========== Auto Timestamp Updates ==========
  const autoTimestampStatuses = [
    { status: 'bill_validated', field: 'bill_validated_at' },
    { status: 'financement_validated', field: 'financement_validated_at' },
    { status: 'mission_card_validated', field: 'mission_card_validated_at' },
    { status: 'in_scholarship', field: 'in_scholarship_at' },
    { status: 'resignation_missing_prerequisites', field: 'resignation_missing_prerequisites_at' },
  ];

  for (const { status, field } of autoTimestampStatuses) {
    if (
      oldCandidate.candidate_admission_status !== status &&
      updatedCandidate.candidate_admission_status === status
    ) {
      await updateCandidateWithTimestamp(_id, field);
    }
  }

  // REFACTOR END: handle various candidate status transitions and related actions

  if (oldCandidate.payment === 'pending' && !oldCandidate.payment_method && candidate_input.payment_method) {
    await CandidateModel.findByIdAndUpdate(updatedCandidate._id, {
      $set: {
        payment: 'pending',
      },
    });
  } else if (
    candidate_input.payment_method &&
    oldCandidate.payment_method !== updatedCandidate.payment_method &&
    updatedCandidate.payment !== 'done'
  ) {
    await CandidateModel.findByIdAndUpdate(updatedCandidate._id, {
      $set: {
        payment: 'not_done',
      },
    });

    if (
      typeOfFormation &&
      !continuousTypeOfFormation.includes(typeOfFormation.type_of_formation) &&
      oldCandidate.readmission_status !== 'readmission_table'
    ) {
      await CandidateUtility.send_FORM_N2(updatedCandidate, lang);
    }
  }
  if (bulkUpdateCandidateQuery.length > 0) {
    await CandidateModel.bulkWrite(bulkUpdateCandidateQuery);
  }

  await StudentAdmissionProcessUtility.updateStudentAdmissionProcessBasedOnStudentData(_id);

  if (candidate_input.payment_method === 'cash' && oldCandidate.payment_method !== candidate_input.payment_method) {
    const masterTransaction = await MasterTransactionModel.findOne({
      status: 'active',
      candidate_id: updatedCandidate._id,
      intake_channel: updatedCandidate.intake_channel,
      operation_name: { $in: ['payment_of_dp', 'down_payment'] },
      status_line_dp_term: 'billed',
    })
      .sort({ _id: -1 })
      .lean();
    if (masterTransaction) {
      await MasterTransactionModel.findByIdAndUpdate(masterTransaction._id, {
        $set: {
          nature: 'cash',
          method_of_payment: 'cash',
          status_line_dp_term: 'pending',
        },
      });
      await MasterTransactionUtilities.SaveMasterTransactionHistory(
        masterTransaction, // *************** old master transaction
        '655ed03e608c5a450cea084e', // *************** user 'zetta' id for actor
        'UpdateCandidate', // *************** function name
        'generate_billing_admission' // *************** action
      );
    }
    candidate_input.payment = 'pending';
  }

  // Check signature if change to done
  if (oldCandidate.signature !== 'done' && updatedCandidate.signature === 'done' && updatedCandidate.billing_id) {
    const billing = await BillingModel.findById(updatedCandidate.billing_id).lean();
    if (billing.amount_billed === 0 && billing.deposit_status === 'paid') {
      const candidateDataUpdated = await CandidateModel.findByIdAndUpdate(
        updatedCandidate._id,
        { $set: { candidate_admission_status: 'registered' } },
        { new: true }
      );

      // *************** Create next candidate for assignment
      //**************** RA_EDH_0188 Keep create readmission assignment student if not exist in assigment table
      const checkResult = await CandidateUtility.CheckCandidateExistInReadmission(updatedCandidate);
      if (!checkResult) {
        const scholarSeason = await ScholarSeasonModel.findById(updatedCandidate.scholar_season).lean();
        if (scholarSeason) {
          const startDate = moment(scholarSeason.from.date_utc, 'DD/MM/YYYY');
          const finishDate = moment(scholarSeason.to.date_utc, 'DD/MM/YYYY');
          const today = moment().utc();

          if (today.isSameOrAfter(startDate) && today.isSameOrBefore(finishDate)) {
            await CandidateModel.findByIdAndUpdate(candidateDataUpdated._id, { $set: { program_status: 'active' } });
          }
        }
        await CandidateUtility.createNextCandidateData(candidateDataUpdated);
      }

      await CandidateUtility.addRegisteredCandidateAsStudent({ candidate: candidateDataUpdated, lang });
      await CandidateUtility.send_REGISTRATION_N7(candidateDataUpdated, lang);
    }
  }

  // Oscar & hubspot update process
  let updatedCandidateNew = await CandidateModel.findById(_id);

  // Update student from candidate
  await CandidateUtility.updateStudentBaseOnCandidate(updatedCandidateNew);

  if (updatedCandidateNew.candidate_admission_status !== candidate_input.candidate_admission_status) {
    delete candidate_input.candidate_admission_status;
  }

  //** remove field payment_supports._id if the value is null */
  if (candidate_input?.payment_supports?.length) {
    candidate_input.payment_supports.forEach((payment_support) => {
      if (payment_support._id === null) delete payment_support._id;
    });
  }


  // REFACTOR START: handle billing payment method update and candidate registration
  // Update billing payment method if changed
  const shouldUpdatePaymentMethod =
    oldCandidate.method_of_payment &&
    updatedCandidate.method_of_payment &&
    oldCandidate.method_of_payment !== updatedCandidate.method_of_payment &&
    updatedCandidate.intake_channel !== null &&
    updatedCandidate.method_of_payment !== 'not_done' &&
    updatedCandidate.billing_id;

  if (shouldUpdatePaymentMethod) {
    await BillingModel.findByIdAndUpdate(updatedCandidate.billing_id, {
      $set: { payment_method: updatedCandidate.method_of_payment },
    });

    const user_id = userId || updatedCandidate.user_id;

    await BillingUtility.AddHistoryUpdateBilling(
      updatedCandidate.billing_id,
      'update_payment_method_down_payment',
      'UpdateCandidate',
      user_id
    );
  }

  // Update candidate with new input
  updatedCandidateNew = await CandidateModel.findByIdAndUpdate(
    _id,
    { $set: candidate_input },
    { new: true }
  );

  // Determine step type based on candidate progress
  const stepConditions = [
    { condition: updatedCandidateNew.payment_method !== null && ['done', 'pending'].includes(updatedCandidateNew.payment), step: 'down_payment_mode' },
    { condition: updatedCandidateNew.signature === 'done', step: 'step_with_signing_process' },
    { condition: updatedCandidateNew.is_admited === 'done', step: 'summary' },
    { condition: updatedCandidateNew.method_of_payment === 'done', step: 'modality_payment' },
    { condition: updatedCandidateNew.presonal_information === 'done', step: 'question_and_field' },
    { condition: updatedCandidateNew.connection === 'done', step: 'campus_validation' },
  ];

  const matchedStep = stepConditions.find(({ condition }) => condition);
  if (matchedStep) {
    const { step } = matchedStep;
    await CandidateModel.findByIdAndUpdate(_id, {
      $set: {
        last_form_updated: {
          step_type: step,
          date_updated: {
            date: moment.utc().format('DD/MM/YYYY'),
            time: moment.utc().format('HH:mm'),
          },
        },
      },
    });
  }

  // Handle candidate registration if signature and payment are complete
  const shouldRegisterCandidate =
    updatedCandidateNew.readmission_status !== 'readmission_table' &&
    updatedCandidateNew.signature === 'done' &&
    updatedCandidateNew.signature !== oldCandidate.signature &&
    typeOfFormation?.type_of_formation === 'classic' &&
    updatedCandidateNew.payment === 'done';

  if (shouldRegisterCandidate) {
    updatedCandidateNew = await CandidateModel.findByIdAndUpdate(
      _id,
      {
        $set: {
          candidate_admission_status: 'registered',
          registered_at: {
            date: moment.utc().format('DD/MM/YYYY'),
            time: moment.utc().format('HH:mm'),
          },
        },
      },
      { new: true }
    );

    if (updatedCandidateNew.candidate_admission_status === 'registered') {
      await CandidateUtility.addRegisteredCandidateAsStudent({ candidate: updatedCandidateNew });

      if (updatedCandidateNew.readmission_status !== 'readmission_table') {
        await CandidateUtility.send_REGISTRATION_N7(updatedCandidateNew);
      }

      if (!updatedCandidateNew.is_registration_recorded) {
        await GeneralDashboardAdmissionUtility.recordCandidateRegistered(updatedCandidateNew, userId);
      }

      await CandidateHistoryUtility.createNewCandidateHistory(
        updatedCandidateNew.billing_id,
        updatedCandidateNew.user_id,
        'update_candidate_campus',
        `Candidate ${updatedCandidateNew._id} registered`
      );
    }
  }

  // REFACTOR END: handle billing payment method update and candidate registration

  /** compare field finance bettwen old and new one */
  if (candidate_input && candidate_input.finance && oldCandidate.finance !== candidate_input.finance) {
    await CandidateUtility.ValidateFinanceGenerated(updatedCandidateNew);
    if (candidate_input && candidate_input.finance && candidate_input.finance === 'family') {
      await BillingUtility.ValidateAndSplitPaymentCandidateFinancialSupport(updatedCandidateNew);
      await MasterTransactionUtilities.GenerateStudentBalanceFI(_id);
    } else if (candidate_input && candidate_input.finance && candidate_input.finance === 'my_self') {
      await MasterTransactionUtilities.GenerateStudentBalanceFI(_id);
    } else if (candidate_input && candidate_input.finance && candidate_input.finance === 'discount') {
      if (typeOfFormation && typeOfFormation.type_of_formation === 'classic') {
        await MasterTransactionUtilities.GenerateStudentBalanceFI(_id);
      }
    }
  }

  //update fs on billing
  if (updatedCandidateNew?.payment_supports?.length) {
    await BillingUtility.updateFinancialSupportBilling(updatedCandidateNew);
  }

  // REFACTOR START: handle candidate admission status updates
  // --- Handle candidate admission status updates ---
  const oldStatus = oldCandidate.candidate_admission_status;
  const newStatus = updatedCandidateNew.candidate_admission_status;
  const hasStatusChanged =
    candidate_input.candidate_admission_status && oldStatus !== newStatus;

  // --- 1️⃣ Generate Student Balance if Candidate Registered ---
  if (hasStatusChanged && newStatus === 'registered') {
    const processId = updatedCandidateNew.admission_process_id;
    await MasterTransactionUtilities.GenerateStudentBalance(
      _id,
      processId,
      !!processId // pass true only if processId exists
    );
  }

  // --- 2️⃣ Sync Candidate Status with External Systems (Oscar Campus or Hubspot) ---
  const syncRequiredStatuses = [
    'registered',
    'resigned',
    'resigned_after_engaged',
    'resigned_after_registered',
    'admitted',
    'admission_in_progress',
  ];

  if (hasStatusChanged && syncRequiredStatuses.includes(newStatus)) {
    if (updatedCandidateNew.oscar_campus_id) {
      await CandidateUtility.changeCandidateStatusInOscarCampus(updatedCandidateNew);
    } else if (updatedCandidateNew.hubspot_deal_id && updatedCandidateNew.hubspot_contact_id) {
      await CandidateUtility.updateCandidateStatusFromHubspot(updatedCandidateNew);
    }
  }

  // --- 3️⃣ Record Candidate Status Change History ---
  if (hasStatusChanged) {
    await CandidateModel.findByIdAndUpdate(_id, {
      $push: {
        status_update_histories: {
          type: is_from_admission_form ? 'platform' : 'user',
          userId: is_from_admission_form ? undefined : context.userId,
          previous_status: oldStatus,
          next_status: newStatus,
          datetime: {
            date: moment.utc().format('DD/MM/YYYY'),
            time: moment.utc().format('HH:mm'),
          },
        },
      },
    });
  }

  // REFACTOR END: handle candidate admission status updates
  
  
  // REFACTOR START: handle minor student logic
  // --- Handle minor student logic ---
  if (is_minor_student === true) {
    // --- Validate emancipated minor document creation ---
    const rejectEmancipatedDoc = await DocumentModel.findOne({
      _id: oldCandidate.emancipated_document_proof_id,
    }).sort({ _id: -1 });

    const isBecomingEmancipatedMinor =
      candidate_input.is_adult === false &&
      (!oldCandidate.is_adult || oldCandidate.is_adult === true) &&
      candidate_input.is_emancipated_minor === true &&
      (!oldCandidate.is_emancipated_minor || oldCandidate.is_emancipated_minor === false);

    const isRejectedEmancipatedDoc =
      candidate_input.is_adult === oldCandidate.is_adult &&
      candidate_input.is_emancipated_minor === oldCandidate.is_emancipated_minor &&
      rejectEmancipatedDoc?.document_status === 'rejected';

    if (isBecomingEmancipatedMinor || isRejectedEmancipatedDoc) {
      const emancipatedDoc = await DocumentModel.create({
        document_name: candidate_input.emancipated_document_proof_original_name || '',
        s3_file_name: candidate_input.emancipated_document_proof_name || '',
        type_of_document: 'emancipated_document_proof',
        document_generation_type: 'emancipated_document',
        document_status: 'validated',
        candidate_id: _id,
        program_id: updatedCandidateNew.intake_channel,
      });

      if (emancipatedDoc) {
        // --- Link new document to candidate ---
        updatedCandidateNew = await CandidateModel.findByIdAndUpdate(
          updatedCandidateNew._id,
          { $set: { emancipated_document_proof_id: emancipatedDoc._id } },
          { new: true }
        );

        // --- Soft delete previously rejected document (same program) ---
        if (rejectEmancipatedDoc) {
          await DocumentModel.findOneAndUpdate(
            {
              _id: rejectEmancipatedDoc._id,
              candidate_id: _id,
              program_id: updatedCandidateNew.intake_channel,
              type_of_document: 'emancipated_document_proof',
              document_status: 'rejected',
            },
            { $set: { status: 'deleted' } },
            { new: true }
          );
        }
      }
    }
  }

  // --- Handle case when candidate is not a minor ---
  if (is_minor_student === false) {
    const becomingMinor =
      candidate_input.is_adult === false &&
      oldCandidate.is_adult !== false &&
      candidate_input.is_emancipated_minor === false &&
      oldCandidate.is_emancipated_minor !== false;

    if (becomingMinor) {
      // --- Notify minor student status change ---
      await CandidateUtility.send_Minor_Student_N3(_id, lang);

      // --- Update candidate personal information to legal representative phase ---
      updatedCandidateNew = await CandidateModel.findByIdAndUpdate(
        updatedCandidateNew._id,
        { $set: { personal_information: 'legal_representative' } },
        { new: true }
      );

      const legalRep = candidate_input.legal_representative || {};

      // --- Validate legal representative email ---
      if (legalRep.email && legalRep.email === updatedCandidateNew.email) {
        throw new Error('Legal representative cannot have the same email as candidate');
      }

      // --- Determine civility based on parental link ---
      const relations = ['father', 'grandfather', 'uncle'];
      const parentalLink = legalRep.parental_link || '';
      const civilityParentalLink = parentalLink === 'other'
        ? ''
        : relations.includes(parentalLink)
          ? 'MR'
          : 'MRS';

      // --- Update candidate legal representative info ---
      await CandidateModel.findByIdAndUpdate(
        updatedCandidateNew._id,
        {
          $set: {
            legal_representative: {
              unique_id: legalRep.unique_id || '',
              civility: legalRep.civility || civilityParentalLink,
              first_name: legalRep.first_name || '',
              last_name: legalRep.last_name || '',
              email: legalRep.email || '',
              phone_number: legalRep.phone_number || '',
              parental_link: legalRep.parental_link || '',
              address: legalRep.address || '',
              postal_code: legalRep.postal_code || '',
              city: legalRep.city || '',
            },
          },
        },
        { new: true }
      );
    }
  }

  // REFACTOR END: handle minor student logic

  // *************** call util GenerateBillingExportControllingReport
  BillingUtility.GenerateBillingExportControllingReport(updatedCandidateNew._id);

  return await CandidateModel.findById(updatedCandidateNew._id);
}
